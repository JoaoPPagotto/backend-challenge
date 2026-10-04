import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Core } from '../../src/composition';
import { TransientInfrastructureError } from '../../src/shared/application/errors/application.errors';
import type { UnitOfWork } from '../../src/shared/application/ports/unit-of-work.port';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.usecase';
import { type CoreHarness, brl, command, createCore, uniq } from '../setup/core-factory';
import { assertLedgerInvariant } from '../setup/invariants';
import { TcpProxy } from '../setup/tcp-proxy';
import { ADMIN_URL } from '../setup/test-db';

let h: CoreHarness;
beforeAll(async () => {
  h = await createCore();
});
afterAll(async () => {
  await h.close();
});

async function newWallet(amount: string) {
  const playerId = crypto.randomUUID();
  const w = await h.core.openWallet.execute({ playerId, initialBalance: brl(amount), correlationId: 'c' });
  return { walletId: w.id, playerId };
}

const bet = (w: { walletId: string; playerId: string }, amount: string, ext = uniq('bet')) =>
  command({
    providerId: 'provider-a',
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'r',
    gameId: 'g',
    kind: 'BET',
    money: brl(amount),
  });

describe('atomicity: wallet, ledger, transaction, inbox and outbox commit together', () => {
  test('failure while writing the outbox rolls back everything', async () => {
    const w = await newWallet('100.00');
    const failingUow: UnitOfWork = {
      read: (work) => h.core.uow.read(work),
      run: (work) =>
        h.core.uow.run((repos) =>
          work({
            ...repos,
            outbox: {
              ...repos.outbox,
              enqueue: async () => {
                throw new Error('boom: outbox write failed');
              },
            },
          }),
        ),
    };
    const useCase = new ProcessWagerTransactionUseCase(
      failingUow,
      h.core.processor,
      h.core.ids,
      h.core.clock,
      h.core.logger,
      h.core.metrics,
      { baseDelayMs: 10 },
    );
    const cmd = bet(w, '30.00');
    cmd.context.inbox = { consumerName: 'test', messageId: uniq('m') };
    await expect(useCase.execute(cmd)).rejects.toThrow('boom');

    const sql = h.db.sql;
    expect((await sql`SELECT balance::text, version FROM wallets WHERE id = ${w.walletId}`)[0]).toEqual({
      balance: '100.00',
      version: 1,
    });
    expect(
      (
        await sql`SELECT COUNT(*)::int c FROM wager_transactions WHERE external_transaction_id = ${cmd.externalTransactionId}`
      )[0].c,
    ).toBe(0);
    expect(
      (await sql`SELECT COUNT(*)::int c FROM wallet_ledger_entries WHERE wallet_id = ${w.walletId}`)[0].c,
    ).toBe(1);
    expect(
      (
        await sql`SELECT COUNT(*)::int c FROM inbox_messages WHERE message_id = ${cmd.context.inbox.messageId}`
      )[0].c,
    ).toBe(0);

    // The same request succeeds afterwards: nothing half-written blocks it.
    const ok = await h.core.processWagerTransaction.execute({
      ...cmd,
      context: { ...cmd.context, inbox: undefined },
    });
    expect(ok).toMatchObject({ status: 'PROCESSED', balance: brl('70.00') });
    await assertLedgerInvariant(sql, w.walletId);
  });
});

describe('reconciliation', () => {
  test('a divergence is reported, counted and never silently corrected', async () => {
    const w = await newWallet('100.00');
    await h.core.processWagerTransaction.execute(bet(w, '10.00'));
    // Out-of-band corruption (e.g. a manual fix gone wrong). The schema trigger normally forbids
    // this, so the test disables it as a superuser to simulate the incident.
    await h.db.sql.begin(async (tx) => {
      await tx`ALTER TABLE wallets DISABLE TRIGGER trg_wallet_ledger_coupling`;
      await tx`UPDATE wallets SET balance = 95.50 WHERE id = ${w.walletId}`;
      await tx`ALTER TABLE wallets ENABLE TRIGGER trg_wallet_ledger_coupling`;
    });
    let divergences = 0;
    const errors: string[] = [];
    const core = await Core.create(
      {
        DATABASE_URL: h.db.url,
        DB_POOL_MAX: 2,
        WALLET_LOCK_TIMEOUT_MS: 1000,
        PENDING_REF_MAX_ATTEMPTS: 1,
        PENDING_REF_TTL_MS: 1,
        PENDING_REF_BASE_DELAY_MS: 1,
        PENDING_REF_MAX_DELAY_MS: 1,
      },
      {
        metrics: { ...h.core.metrics, reconciliationDivergence: () => void divergences++ } as never,
        logger: { ...h.core.logger, error: (msg: string) => void errors.push(msg) } as never,
      },
    );
    try {
      const report = await core.reconcileWallet.execute(w.walletId);
      expect(report).toEqual({
        walletId: w.walletId,
        storedBalance: brl('95.50'),
        calculatedBalance: brl('90.00'),
        difference: brl('5.50'),
        consistent: false,
        checkedEntries: 2,
      });
      expect(divergences).toBe(1);
      expect(errors).toContain('wallet reconciliation divergence detected');
      // Not corrected:
      expect((await h.db.sql`SELECT balance::text FROM wallets WHERE id = ${w.walletId}`)[0].balance).toBe(
        '95.50',
      );
    } finally {
      await core.close();
      // Restore for the global invariant of other files (append a correcting state is not possible: fix balance back).
      await h.db.sql.begin(async (tx) => {
        await tx`ALTER TABLE wallets DISABLE TRIGGER trg_wallet_ledger_coupling`;
        await tx`UPDATE wallets SET balance = 90.00 WHERE id = ${w.walletId}`;
        await tx`ALTER TABLE wallets ENABLE TRIGGER trg_wallet_ledger_coupling`;
      });
    }
  });
});

describe('PostgreSQL temporarily unavailable (real network outage via TCP proxy)', () => {
  test('requests fail as transient while down, succeed after recovery, no partial state', async () => {
    const admin = new URL(ADMIN_URL);
    const proxy = new TcpProxy(admin.hostname, Number(admin.port || 5432));
    await proxy.start();
    const viaProxy = new URL(h.db.url);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(proxy.port);
    const core = await Core.create({
      DATABASE_URL: viaProxy.toString(),
      DB_POOL_MAX: 4,
      WALLET_LOCK_TIMEOUT_MS: 1000,
      PENDING_REF_MAX_ATTEMPTS: 3,
      PENDING_REF_TTL_MS: 60_000,
      PENDING_REF_BASE_DELAY_MS: 1,
      PENDING_REF_MAX_DELAY_MS: 5,
    });
    try {
      const playerId = crypto.randomUUID();
      const opened = await core.openWallet.execute({
        playerId,
        initialBalance: brl('50.00'),
        correlationId: 'c',
      });
      const w = { walletId: opened.id, playerId };
      expect((await core.processWagerTransaction.execute(bet(w, '5.00'))).status as string).toBe('PROCESSED');

      proxy.stop();
      const during = bet(w, '7.00');
      await expect(core.processWagerTransaction.execute(during)).rejects.toBeInstanceOf(
        TransientInfrastructureError,
      );

      await proxy.restart();
      let result: Awaited<ReturnType<typeof core.processWagerTransaction.execute>> | undefined;
      for (let i = 0; i < 20 && !result; i++) {
        try {
          result = await core.processWagerTransaction.execute(during);
        } catch (e) {
          if (!(e instanceof TransientInfrastructureError)) throw e;
          await Bun.sleep(100);
        }
      }
      expect(result).toMatchObject({ status: 'PROCESSED', balance: brl('38.00'), idempotentReplay: false });
      await assertLedgerInvariant(h.db.sql, w.walletId);
    } finally {
      await core.close();
      proxy.stop();
    }
  });
});
