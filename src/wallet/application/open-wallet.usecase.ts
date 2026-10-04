import { OutboxMessage } from '../../outbox/domain/outbox-message';
import type { Clock } from '../../shared/application/ports/clock.port';
import type { IdGenerator } from '../../shared/application/ports/id-generator.port';
import type { AppLogger } from '../../shared/application/ports/observability.port';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.port';
import { ValidationError } from '../../shared/domain/errors/domain.error';
import { Money, type MoneyProps } from '../../shared/domain/money/money';
import { WalletBalanceChanged } from '../../wagering/application/events/wagering-events';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { type WalletView, toWalletView } from './wallet.dto';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/**
 * Creates the wallet and, when the initial balance is positive, the internal OPENING
 * transaction + CREDIT ledger entry + WalletBalanceChanged event — all in one SQL transaction.
 * The opening is the initial state, so version stays 1.
 */
export class OpenWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  async execute(cmd: OpenWalletCommand): Promise<WalletView> {
    const initial = Money.from(cmd.initialBalance);
    if (initial.isNegative()) throw new ValidationError('initialBalance cannot be negative');
    const now = this.clock.now();
    const wallet = Wallet.open({
      id: this.ids.next(),
      playerId: cmd.playerId,
      initialBalance: initial,
      at: now,
    });

    await this.uow.run(async (repos) => {
      await repos.wallets.insert(wallet);
      if (!initial.isPositive()) return;
      const opening = WagerTransaction.createOpening({
        id: this.ids.next(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initial,
        at: now,
      });
      const entry = wallet.openingEntry({
        ledgerEntryId: this.ids.next(),
        transactionId: opening.id,
        at: now,
      });
      await repos.transactions.insertIfAbsent(opening);
      await repos.ledger.append(entry);
      await repos.outbox.enqueue([
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, entry, {
            eventId: this.ids.next(),
            correlationId: cmd.correlationId,
            occurredAt: now,
          }),
        ),
      ]);
    });

    this.logger.info('wallet opened', { walletId: wallet.id });
    return toWalletView(wallet);
  }
}
