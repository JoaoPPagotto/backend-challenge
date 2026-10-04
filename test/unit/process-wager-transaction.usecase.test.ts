import { beforeEach, describe, expect, test } from 'bun:test';
import { SystemClock } from '../../src/shared/application/ports/clock.port';
import { UuidV7Generator } from '../../src/shared/application/ports/id-generator.port';
import { NoopLogger, NoopMetrics } from '../../src/shared/application/ports/observability.port';
import { FailureCode } from '../../src/shared/domain/errors/failure-code';
import { InvalidMoneyError } from '../../src/shared/domain/money/money.errors';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/wagering/application/process-wager-transaction.usecase';
import { WagerProcessor } from '../../src/wagering/application/wager-processor';
import {
  IdempotencyConflictError,
  KindNotAllowedError,
} from '../../src/wagering/domain/wager-transaction.errors';
import { OpenWalletUseCase } from '../../src/wallet/application/open-wallet.usecase';
import { InMemoryUnitOfWork } from './in-memory-repositories';

const ids = new UuidV7Generator();
const clock = new SystemClock();
let uow: InMemoryUnitOfWork;
let useCase: ProcessWagerTransactionUseCase;
let wallet: { walletId: string; playerId: string };

beforeEach(async () => {
  uow = new InMemoryUnitOfWork();
  useCase = new ProcessWagerTransactionUseCase(
    uow,
    new WagerProcessor(ids, clock),
    ids,
    clock,
    new NoopLogger(),
    new NoopMetrics(),
    { baseDelayMs: 1000 },
  );
  const playerId = crypto.randomUUID();
  const w = await new OpenWalletUseCase(uow, ids, clock, new NoopLogger()).execute({
    playerId,
    initialBalance: { amount: '100.00', currency: 'BRL' },
    correlationId: 'c',
  });
  wallet = { walletId: w.id, playerId };
});

let n = 0;
function cmd(
  kind: string,
  amount: string,
  extra: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  n += 1;
  const ext = `e-${n}`;
  return {
    idempotencyKey: `p:${ext}`,
    providerId: 'p',
    externalTransactionId: ext,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'r',
    gameId: 'g',
    kind: kind as ProcessWagerTransactionCommand['kind'],
    money: { amount, currency: 'BRL' },
    context: { channel: 'http', correlationId: 'c' },
    ...extra,
  };
}

const events = () => uow.store.outbox.map((o) => o.eventType);

describe('ProcessWagerTransactionUseCase (unit, in-memory)', () => {
  test('BET debits and emits Processed + BalanceChanged', async () => {
    const r = await useCase.execute(cmd('BET', '25.00'));
    expect(r).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });
    expect(events().slice(-2)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('LOSS emits Processed only (balance unchanged → no BalanceChanged)', async () => {
    const before = uow.store.outbox.length;
    await useCase.execute(cmd('LOSS', '25.00'));
    expect(events().slice(before)).toEqual(['WagerTransactionProcessed']);
    expect(uow.store.wallets.get(wallet.walletId)?.version).toBe(1);
  });

  test('idempotency key with divergent payload → IdempotencyConflictError', async () => {
    const c = cmd('BET', '10.00');
    await useCase.execute(c);
    await expect(
      useCase.execute({ ...c, money: { amount: '10.01', currency: 'BRL' } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(useCase.execute({ ...c, gameId: 'other' })).rejects.toBeInstanceOf(IdempotencyConflictError);
    const replay = await useCase.execute(c);
    expect(replay.idempotentReplay).toBe(true);
  });

  test('currency conflict is a business rejection', async () => {
    const r = await useCase.execute({ ...cmd('BET', '1.00'), money: { amount: '1.00', currency: 'USD' } });
    expect(r).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.CurrencyMismatch });
    expect(events().at(-1)).toBe('WagerTransactionRejected');
  });

  test('REFUND / ROLLBACK rules', async () => {
    const bet = cmd('BET', '40.00');
    await useCase.execute(bet);
    expect(
      await useCase.execute(
        cmd('REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }),
      ),
    ).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
    expect(
      await useCase.execute(
        cmd('ROLLBACK', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }),
      ),
    ).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.ReferenceAlreadyReversed });
    const pending = await useCase.execute(
      cmd('ROLLBACK', '1.00', { referenceExternalTransactionId: 'missing' }),
    );
    expect(pending.status as string).toBe('PENDING_REFERENCE');
    expect(events().at(-1)).toBe('WagerTransactionPendingReference');
  });

  test('invalid input is rejected before touching state', async () => {
    await expect(useCase.execute(cmd('OPENING', '1.00'))).rejects.toBeInstanceOf(KindNotAllowedError);
    await expect(useCase.execute(cmd('BET', '1.001'))).rejects.toBeInstanceOf(InvalidMoneyError);
    await expect(useCase.execute(cmd('BET', '0.00'))).rejects.toThrow('greater than zero');
    expect(uow.store.transactions.size).toBe(1); // only the OPENING
  });
});
