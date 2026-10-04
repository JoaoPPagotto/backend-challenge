import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { http, type AppInstance, openWallet, startInstances, stopAll } from '../setup/instances';
import { assertLedgerInvariant } from '../setup/invariants';
import { type TestDatabase, createTestDatabase } from '../setup/test-db';
import { createTestQueues, sqsClient } from '../setup/test-sqs';

let db: TestDatabase;
let app: AppInstance;
let url: string;

beforeAll(async () => {
  db = await createTestDatabase('http');
  const queues = await createTestQueues(sqsClient());
  [app] = (await startInstances(1, { databaseUrl: db.url, queues }, 'http')) as [AppInstance];
  url = app.url;
});

afterAll(async () => {
  await stopAll([app]);
  await assertLedgerInvariant(db.sql);
  await db.drop();
});

const money = (amount: string, currency = 'BRL') => ({ amount, currency });
let n = 0;
function body(
  w: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  n += 1;
  return {
    providerId: 'provider-a',
    externalTransactionId: `http-${Date.now()}-${n}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: money(amount),
    ...extra,
  };
}
const submit = (b: Record<string, unknown>, key = `${b.providerId}:${b.externalTransactionId}`) =>
  http(url, 'POST', '/wagering/transactions', b, { 'Idempotency-Key': key });

describe('wallets', () => {
  test('POST /wallets → 201 with the contract of the challenge', async () => {
    const playerId = crypto.randomUUID();
    const res = await http(url, 'POST', '/wallets', { playerId, initialBalance: money('1000.00') });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: money('1000.00'),
      version: 1,
    });
    const dup = await http(url, 'POST', '/wallets', { playerId, initialBalance: money('1.00') });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('WALLET_ALREADY_EXISTS');
  });

  test.each([
    [{ playerId: 'not-a-uuid', initialBalance: money('1.00') }],
    [{ playerId: crypto.randomUUID(), initialBalance: { amount: 10, currency: 'BRL' } }],
    [{ playerId: crypto.randomUUID(), initialBalance: money('1e3') }],
    [{ playerId: crypto.randomUUID(), initialBalance: money('-1.00') }],
    [{ playerId: crypto.randomUUID(), initialBalance: money('1.001') }],
    [{ playerId: crypto.randomUUID(), initialBalance: money('1.00', 'brl') }],
  ])('invalid wallet payload → 400 %#', async (payload) => {
    const res = await http(url, 'POST', '/wallets', payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });

  test('GET unknown wallet → 404; malformed id → 400', async () => {
    expect((await http(url, 'GET', `/wallets/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await http(url, 'GET', '/wallets/xyz')).status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('full flow and status mapping', async () => {
    const w = await openWallet(url, '1000.00');
    const bet = body(w, 'BET', '25.00');
    const r1 = await submit(bet);
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: money('975.00'),
      idempotentReplay: false,
    });

    const replay = await submit(bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...r1.body, idempotentReplay: true });

    const conflict = await submit({ ...bet, money: money('26.00') });
    expect(conflict.status).toBe(409);
    expect(conflict.body.failureCode).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(conflict.body.correlationId).toEqual(expect.any(String));

    const win = await submit(
      body(w, 'WIN', '100.00', { referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(win.status).toBe(200);
    expect(win.body.balance).toEqual(money('1075.00'));

    const rejected = await submit(body(w, 'BET', '5000.00'));
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' });

    const pending = await submit(body(w, 'ROLLBACK', '10.00', { referenceExternalTransactionId: 'not-yet' }));
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    const rec = await http(url, 'POST', `/wallets/${w.walletId}/reconciliation`);
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ consistent: true, difference: money('0.00'), checkedEntries: 3 });

    const byId = await http(url, 'GET', `/wagering/transactions/${r1.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: money('25.00') });
    const byExt = await http(
      url,
      'GET',
      `/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`,
    );
    expect(byExt.body.id).toBe(r1.body.transactionId);
    expect((await http(url, 'GET', '/providers/provider-a/wagering/transactions/nope')).status).toBe(404);
  });

  test('Idempotency-Key header is mandatory', async () => {
    const w = await openWallet(url, '10.00');
    const res = await http(url, 'POST', '/wagering/transactions', body(w, 'BET', '1.00'));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });

  test('replay with a different key for the same external id is a conflict', async () => {
    const w = await openWallet(url, '10.00');
    const b = body(w, 'BET', '1.00');
    expect((await submit(b)).status).toBe(200);
    expect((await submit(b, 'another-key')).status).toBe(409);
  });

  test.each([
    ['OPENING is internal', { kind: 'OPENING' }],
    ['unknown kind', { kind: 'JACKPOT' }],
    ['number for money', { money: { amount: 25, currency: 'BRL' } }],
    ['scientific notation', { money: money('1e2') }],
    ['three decimals', { money: money('1.005') }],
    ['zero amount', { money: money('0.00') }],
    ['negative amount', { money: money('-5.00') }],
    ['REFUND without reference', { kind: 'REFUND' }],
    ['unknown field', { extra: 'x' }],
    ['BET with reference', { referenceExternalTransactionId: 'x' }],
  ])('400 for %s', async (_name, patch) => {
    const w = { walletId: crypto.randomUUID(), playerId: crypto.randomUUID() };
    const res = await submit({ ...body(w, 'BET', '1.00'), ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });

  test('malformed JSON → 400, still with a correlation id', async () => {
    const res = await http(url, 'POST', '/wagering/transactions', '{nope', {
      'Idempotency-Key': 'k',
      'X-Correlation-Id': 'bad-json-1',
    });
    expect(res.status).toBe(400);
    expect(res.body.correlationId).toBe('bad-json-1');
  });
});

describe('ledger', () => {
  test('cursor pagination is stable and opaque', async () => {
    const w = await openWallet(url, '100.00');
    for (let i = 0; i < 5; i++) await submit(body(w, 'BET', '1.00'));
    const p1 = await http<{ items: { id: string }[]; nextCursor: string }>(
      url,
      'GET',
      `/wallets/${w.walletId}/ledger?limit=4`,
    );
    expect(p1.body.items).toHaveLength(4);
    expect(p1.body.nextCursor).toEqual(expect.any(String));
    const p2 = await http<{ items: { id: string }[]; nextCursor: string | null }>(
      url,
      'GET',
      `/wallets/${w.walletId}/ledger?limit=4&cursor=${p1.body.nextCursor}`,
    );
    expect(p2.body.items).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();
    expect((await http(url, 'GET', `/wallets/${w.walletId}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await http(url, 'GET', `/wallets/${w.walletId}/ledger?limit=0`)).status).toBe(400);
  });
});

describe('operability', () => {
  test('health endpoints are open; readiness checks postgres and sqs', async () => {
    expect((await http(url, 'GET', '/health/live')).status).toBe(200);
    const ready = await http(url, 'GET', '/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: 'up', sqs: 'up' });
  });

  test('metrics expose the required series', async () => {
    const res = await http<string>(url, 'GET', '/metrics');
    for (const name of [
      'wager_transactions_total',
      'idempotent_replays_total',
      'idempotency_conflicts_total',
      'inbox_duplicates_total',
      'wallet_lock_conflicts_total',
      'sqs_messages_retried_total',
      'sqs_messages_dlq_total',
      'outbox_pending',
      'outbox_lag_seconds',
      'transaction_processing_duration_seconds',
    ]) {
      expect(res.body).toContain(name);
    }
  });

  test('correlation id is propagated and logs are JSON without money', async () => {
    const w = await openWallet(url, '50.00');
    const res = await fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'corr-test',
        'X-Correlation-Id': 'corr-abc-123',
      },
      body: JSON.stringify(body(w, 'BET', '12.34', { externalTransactionId: 'corr-test' })),
    });
    expect(res.headers.get('x-correlation-id')).toBe('corr-abc-123');
    await Bun.sleep(200);
    const lines = app.logs.filter((l) => l.includes('corr-abc-123'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.correlationId).toBe('corr-abc-123');
      expect(line).not.toContain('12.34');
    }
    const handled = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'wager transaction handled');
    expect(handled).toMatchObject({
      walletId: w.walletId,
      providerId: 'provider-a',
      transactionId: expect.any(String),
    });
    for (const line of app.logs) {
      expect(line).not.toMatch(/"(amount|balance|money)"/);
    }
  });
});
