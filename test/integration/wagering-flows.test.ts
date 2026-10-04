import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/shared/domain/errors/failure-code';
import { IdempotencyConflictError } from '../../src/wagering/domain/wager-transaction.errors';
import { WalletAlreadyExistsError } from '../../src/wallet/domain/wallet.errors';
import { type CoreHarness, brl, command, createCore, uniq } from '../setup/core-factory';
import { assertLedgerInvariant } from '../setup/invariants';

let h: CoreHarness;
beforeAll(async () => {
  h = await createCore();
});
afterAll(async () => {
  await assertLedgerInvariant(h.db.sql);
  await h.close();
});

async function newWallet(amount = '100.00') {
  const playerId = crypto.randomUUID();
  const w = await h.core.openWallet.execute({ playerId, initialBalance: brl(amount), correlationId: 'c' });
  return { walletId: w.id, playerId };
}

function tx(
  w: { walletId: string; playerId: string },
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK',
  amount: string,
  extra: { ext?: string; ref?: string; round?: string; provider?: string } = {},
) {
  return command({
    providerId: extra.provider ?? 'provider-a',
    externalTransactionId: extra.ext ?? uniq('tx'),
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: extra.round ?? 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: extra.ref,
  });
}

describe('wallet opening', () => {
  test('OPENING transaction + CREDIT entry in the same SQL transaction; version 1', async () => {
    const w = await newWallet('1000.00');
    const view = await h.core.getWallet.execute(w.walletId);
    expect(view.balance).toEqual(brl('1000.00'));
    expect(view.version).toBe(1);
    const ledger = await h.core.listLedger.execute(w.walletId, undefined, 50);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]?.direction).toBe('CREDIT');
    const [opening] = await h.db
      .sql`SELECT kind, status FROM wager_transactions WHERE wallet_id = ${w.walletId}`;
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });
  });

  test('zero initial balance creates no ledger entry', async () => {
    const w = await newWallet('0.00');
    const ledger = await h.core.listLedger.execute(w.walletId, undefined, 50);
    expect(ledger.items).toHaveLength(0);
  });

  test('duplicate (playerId, currency) is a conflict', async () => {
    const playerId = crypto.randomUUID();
    await h.core.openWallet.execute({ playerId, initialBalance: brl('1.00'), correlationId: 'c' });
    await expect(
      h.core.openWallet.execute({ playerId, initialBalance: brl('1.00'), correlationId: 'c' }),
    ).rejects.toThrow(WalletAlreadyExistsError);
    // Same player, other currency is fine (multi-currency model).
    await h.core.openWallet.execute({
      playerId,
      initialBalance: { amount: '1.00', currency: 'USD' },
      correlationId: 'c',
    });
  });
});

describe('BET / WIN / LOSS', () => {
  test('BET debits, WIN credits, LOSS records without moving balance or version', async () => {
    const w = await newWallet('100.00');
    const bet = await h.core.processWagerTransaction.execute(tx(w, 'BET', '25.00'));
    expect(bet).toMatchObject({ status: 'PROCESSED', balance: brl('75.00'), idempotentReplay: false });
    const win = await h.core.processWagerTransaction.execute(tx(w, 'WIN', '50.00'));
    expect(win.balance).toEqual(brl('125.00'));
    const loss = await h.core.processWagerTransaction.execute(tx(w, 'LOSS', '10.00'));
    expect(loss).toMatchObject({ status: 'PROCESSED', balance: brl('125.00') });
    const view = await h.core.getWallet.execute(w.walletId);
    expect(view.version).toBe(3);
    const ledger = await h.core.listLedger.execute(w.walletId, undefined, 50);
    expect(ledger.items).toHaveLength(3); // opening + bet + win
    const types = await h.db
      .sql`SELECT event_type FROM outbox_messages WHERE aggregate_id IN (${loss.transactionId})`;
    expect(types.map((t: { event_type: string }) => t.event_type)).toEqual(['WagerTransactionProcessed']);
    await assertLedgerInvariant(h.db.sql, w.walletId);
  });

  test('BET without funds is REJECTED (INSUFFICIENT_BALANCE), no ledger entry, rejected event', async () => {
    const w = await newWallet('10.00');
    const r = await h.core.processWagerTransaction.execute(tx(w, 'BET', '10.01'));
    expect(r).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.InsufficientBalance,
      balance: brl('10.00'),
    });
    const [{ count }] = await h.db
      .sql`SELECT COUNT(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id = ${r.transactionId}`;
    expect(count).toBe(0);
    const [ev] = await h.db
      .sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${r.transactionId}`;
    expect(ev.event_type).toBe('WagerTransactionRejected');
  });

  test('currency of the operation must match the wallet', async () => {
    const w = await newWallet('10.00');
    const c = tx(w, 'BET', '1.00');
    c.money = { amount: '1.00', currency: 'USD' };
    const r = await h.core.processWagerTransaction.execute(c);
    expect(r).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.CurrencyMismatch });
  });

  test('unknown wallet and wrong player are rejected and auditable', async () => {
    const w = await newWallet('10.00');
    const unknown = await h.core.processWagerTransaction.execute(
      tx({ walletId: crypto.randomUUID(), playerId: w.playerId }, 'BET', '1.00'),
    );
    expect(unknown).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.WalletNotFound,
      balance: null,
    });
    const wrong = await h.core.processWagerTransaction.execute(
      tx({ ...w, playerId: crypto.randomUUID() }, 'BET', '1.00'),
    );
    expect(wrong).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.WalletPlayerMismatch });
  });
});

describe('idempotency', () => {
  test('identical request replays the original result, including the balance observed then', async () => {
    const w = await newWallet('100.00');
    const c = tx(w, 'BET', '30.00');
    const first = await h.core.processWagerTransaction.execute(c);
    await h.core.processWagerTransaction.execute(tx(w, 'BET', '10.00'));
    const again = await h.core.processWagerTransaction.execute({ ...c, context: { ...c.context } });
    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(again.balance).toEqual(brl('70.00'));
  });

  test('same key with different payload is a conflict, not a replay', async () => {
    const w = await newWallet('100.00');
    const c = tx(w, 'BET', '30.00');
    await h.core.processWagerTransaction.execute(c);
    await expect(h.core.processWagerTransaction.execute({ ...c, money: brl('31.00') })).rejects.toThrow(
      IdempotencyConflictError,
    );
    await expect(h.core.processWagerTransaction.execute({ ...c, roundId: 'other' })).rejects.toThrow(
      IdempotencyConflictError,
    );
    await expect(
      h.core.processWagerTransaction.execute({ ...c, idempotencyKey: 'another-key-same-external-id' }),
    ).rejects.toThrow(IdempotencyConflictError);
    const view = await h.core.getWallet.execute(w.walletId);
    expect(view.balance).toEqual(brl('70.00'));
  });

  test('replay of a rejection returns the same rejection', async () => {
    const w = await newWallet('1.00');
    const c = tx(w, 'BET', '2.00');
    const first = await h.core.processWagerTransaction.execute(c);
    await h.core.processWagerTransaction.execute(tx(w, 'WIN', '5.00'));
    const again = await h.core.processWagerTransaction.execute(c);
    expect(again).toEqual({ ...first, idempotentReplay: true });
  });
});

describe('REFUND / ROLLBACK', () => {
  test('REFUND credits a processed BET exactly once', async () => {
    const w = await newWallet('100.00');
    const bet = tx(w, 'BET', '40.00');
    await h.core.processWagerTransaction.execute(bet);
    const refund = await h.core.processWagerTransaction.execute(
      tx(w, 'REFUND', '40.00', { ref: bet.externalTransactionId }),
    );
    expect(refund).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    const second = await h.core.processWagerTransaction.execute(
      tx(w, 'REFUND', '40.00', { ref: bet.externalTransactionId }),
    );
    expect(second).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.ReferenceAlreadyReversed });
    const rb = await h.core.processWagerTransaction.execute(
      tx(w, 'ROLLBACK', '40.00', { ref: bet.externalTransactionId }),
    );
    expect(rb).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.ReferenceAlreadyReversed });
    await assertLedgerInvariant(h.db.sql, w.walletId);
  });

  test('REFUND only references BET; amount must match; same round', async () => {
    const w = await newWallet('100.00');
    const win = tx(w, 'WIN', '10.00');
    await h.core.processWagerTransaction.execute(win);
    expect(
      await h.core.processWagerTransaction.execute(
        tx(w, 'REFUND', '10.00', { ref: win.externalTransactionId }),
      ),
    ).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.ReferenceKindNotAllowed });
    const bet = tx(w, 'BET', '10.00');
    await h.core.processWagerTransaction.execute(bet);
    expect(
      await h.core.processWagerTransaction.execute(
        tx(w, 'REFUND', '9.00', { ref: bet.externalTransactionId }),
      ),
    ).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.AmountMismatch });
    expect(
      await h.core.processWagerTransaction.execute(
        tx(w, 'REFUND', '10.00', { ref: bet.externalTransactionId, round: 'round-2' }),
      ),
    ).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.ReferenceMismatch });
  });

  test('reference to a REJECTED transaction is REFERENCE_NOT_PROCESSED', async () => {
    const w = await newWallet('1.00');
    const bet = tx(w, 'BET', '5.00');
    await h.core.processWagerTransaction.execute(bet);
    expect(
      await h.core.processWagerTransaction.execute(
        tx(w, 'REFUND', '5.00', { ref: bet.externalTransactionId }),
      ),
    ).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.ReferenceNotProcessed });
  });

  test('ROLLBACK reverses BET, WIN and REFUND', async () => {
    const w = await newWallet('100.00');
    const bet = tx(w, 'BET', '20.00');
    await h.core.processWagerTransaction.execute(bet);
    expect(
      await h.core.processWagerTransaction.execute(
        tx(w, 'ROLLBACK', '20.00', { ref: bet.externalTransactionId }),
      ),
    ).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });

    const win = tx(w, 'WIN', '30.00');
    await h.core.processWagerTransaction.execute(win);
    expect(
      await h.core.processWagerTransaction.execute(
        tx(w, 'ROLLBACK', '30.00', { ref: win.externalTransactionId }),
      ),
    ).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });

    const bet2 = tx(w, 'BET', '15.00');
    await h.core.processWagerTransaction.execute(bet2);
    const refund = tx(w, 'REFUND', '15.00', { ref: bet2.externalTransactionId });
    await h.core.processWagerTransaction.execute(refund);
    expect(
      await h.core.processWagerTransaction.execute(
        tx(w, 'ROLLBACK', '15.00', { ref: refund.externalTransactionId }),
      ),
    ).toMatchObject({ status: 'PROCESSED', balance: brl('85.00') });
    await assertLedgerInvariant(h.db.sql, w.walletId);
  });

  test('ROLLBACK that would overdraw is rejected with a distinct code', async () => {
    const w = await newWallet('0.00');
    const win = tx(w, 'WIN', '50.00');
    await h.core.processWagerTransaction.execute(win);
    await h.core.processWagerTransaction.execute(tx(w, 'BET', '40.00'));
    const rb = await h.core.processWagerTransaction.execute(
      tx(w, 'ROLLBACK', '50.00', { ref: win.externalTransactionId }),
    );
    expect(rb).toMatchObject({
      status: 'REJECTED',
      failureCode: FailureCode.ReversalWouldOverdraw,
      balance: brl('10.00'),
    });
    expect(rb.failureCode).not.toBe(FailureCode.InsufficientBalance);
  });

  test('reference arriving later: PENDING_REFERENCE then applied by the worker', async () => {
    const w = await newWallet('100.00');
    const betExt = uniq('late-bet');
    const rb = await h.core.processWagerTransaction.execute(tx(w, 'ROLLBACK', '25.00', { ref: betExt }));
    expect(rb).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00') });
    // replay while pending
    expect((await h.core.getTransaction.byId(rb.transactionId)).status as string).toBe('PENDING_REFERENCE');

    await h.core.processWagerTransaction.execute(tx(w, 'BET', '25.00', { ext: betExt }));
    let status = 'PENDING_REFERENCE';
    for (let i = 0; i < 20 && status === 'PENDING_REFERENCE'; i++) {
      await h.core.retryPendingReferences.runOnce();
      status = (await h.core.getTransaction.byId(rb.transactionId)).status;
    }
    expect(status).toBe('PROCESSED');
    expect((await h.core.getWallet.execute(w.walletId)).balance).toEqual(brl('100.00'));
    await assertLedgerInvariant(h.db.sql, w.walletId);
  });

  test('reference that never arrives is rejected with REFERENCE_NOT_FOUND after the limit', async () => {
    const w = await newWallet('100.00');
    const r = await h.core.processWagerTransaction.execute(tx(w, 'REFUND', '5.00', { ref: uniq('ghost') }));
    expect(r.status as string).toBe('PENDING_REFERENCE');
    let status = r.status as string;
    for (let i = 0; i < 50 && status === 'PENDING_REFERENCE'; i++) {
      await Bun.sleep(5);
      await h.core.retryPendingReferences.runOnce();
      status = (await h.core.getTransaction.byId(r.transactionId)).status;
    }
    const view = await h.core.getTransaction.byId(r.transactionId);
    expect(view).toMatchObject({ status: 'REJECTED', failureCode: FailureCode.ReferenceNotFound });
    const events = await h.db
      .sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${r.transactionId} ORDER BY occurred_at`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
  });
});

describe('reconciliation', () => {
  test('consistent wallet', async () => {
    const w = await newWallet('975.00');
    await h.core.processWagerTransaction.execute(tx(w, 'BET', '75.00'));
    const r = await h.core.reconcileWallet.execute(w.walletId);
    expect(r).toEqual({
      walletId: w.walletId,
      storedBalance: brl('900.00'),
      calculatedBalance: brl('900.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe('ledger pagination', () => {
  test('stable opaque cursor', async () => {
    const w = await newWallet('100.00');
    for (let i = 0; i < 7; i++) await h.core.processWagerTransaction.execute(tx(w, 'BET', '1.00'));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await h.core.listLedger.execute(w.walletId, cursor, 3);
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect([...seen].sort()).toEqual(seen);
  });
});
