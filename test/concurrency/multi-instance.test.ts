import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { QueueSet } from '../../scripts/init-sqs';
import {
  http,
  AppInstance,
  freePort,
  openWallet,
  startInstances,
  stopAll,
  waitFor,
} from '../setup/instances';
import { assertLedgerInvariant } from '../setup/invariants';
import { type TestDatabase, createTestDatabase } from '../setup/test-db';
import { createTestQueues, drain, sendWager, sqsClient } from '../setup/test-sqs';

/**
 * Real parallelism: 3 application processes (`bun src/main.ts`) sharing one PostgreSQL and
 * one SQS endpoint. Requests are spread round-robin across the instances.
 */
let db: TestDatabase;
let client: SQSClient;
let queues: QueueSet;
let apps: AppInstance[];
let rr = 0;
const next = () => {
  rr += 1;
  return apps[rr % apps.length] as AppInstance;
};
const seenInstances = new Set<string>();

beforeAll(async () => {
  db = await createTestDatabase('conc');
  client = sqsClient();
  queues = await createTestQueues(client, { visibilityTimeoutSeconds: 3 });
  apps = await startInstances(3, { databaseUrl: db.url, queues }, 'node');
});

afterAll(async () => {
  await stopAll(apps);
  await assertLedgerInvariant(db.sql);
  await db.drop();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });
let seq = 0;
function tx(
  w: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, string> = {},
) {
  seq += 1;
  return {
    providerId: 'provider-c',
    externalTransactionId: `c-${Date.now().toString(36)}-${seq}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'g',
    kind,
    money: brl(amount),
    ...extra,
  };
}
async function submit(body: ReturnType<typeof tx>, instance = next()) {
  const res = await http<{
    status: string;
    failureCode?: string;
    idempotentReplay: boolean;
    balance: unknown;
    transactionId: string;
  }>(instance.url, 'POST', '/wagering/transactions', body, {
    'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
  });
  if (res.instance) seenInstances.add(res.instance);
  return res;
}
const debitsOf = async (walletId: string) =>
  (
    await db.sql`SELECT COUNT(*)::int c FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`
  )[0].c as number;
const balanceOf = async (walletId: string) =>
  (await db.sql`SELECT balance::text b FROM wallets WHERE id = ${walletId}`)[0].b as string;

describe('concurrency across 3 instances', () => {
  test('1. the same BET sent 50 times in parallel → a single debit', async () => {
    const w = await openWallet(apps[0]?.url ?? '', '100.00');
    const body = tx(w, 'BET', '10.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(body)));
    expect(results.every((r) => r.status === 200 && r.body.status === 'PROCESSED')).toBe(true);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => JSON.stringify(r.body.balance) === JSON.stringify(brl('90.00')))).toBe(true);
    expect(await debitsOf(w.walletId)).toBe(1);
    expect(await balanceOf(w.walletId)).toBe('90.00');
    await assertLedgerInvariant(db.sql, w.walletId);
  });

  test('2. mandatory scenario: 100.00, two 80.00 BETs at the same time (×20)', async () => {
    for (let round = 0; round < 20; round++) {
      const w = await openWallet(apps[0]?.url ?? '', '100.00');
      const [a, b] = await Promise.all([
        submit(tx(w, 'BET', '80.00'), apps[0]),
        submit(tx(w, 'BET', '80.00'), apps[1]),
      ]);
      const statuses = [a.body.status, b.body.status].sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      const rejected = a.body.status === 'REJECTED' ? a : b;
      expect(rejected.status).toBe(422);
      expect(rejected.body.failureCode).toBe('INSUFFICIENT_BALANCE');
      expect(await balanceOf(w.walletId)).toBe('20.00');
      expect(await debitsOf(w.walletId)).toBe(1);
      // retries of both never duplicate the debit
      await Promise.all([submit(tx(w, 'BET', '80.00', { externalTransactionId: 'x' }), apps[2])]);
      expect(await debitsOf(w.walletId)).toBe(1);
      await assertLedgerInvariant(db.sql, w.walletId);
    }
  });

  test('2b. hot wallet: 100 concurrent 1.00 BETs against 50.00 → exactly 50 succeed', async () => {
    const w = await openWallet(apps[0]?.url ?? '', '50.00');
    const results = await Promise.all(Array.from({ length: 100 }, () => submit(tx(w, 'BET', '1.00'))));
    expect(results.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(50);
    expect(results.filter((r) => r.body.failureCode === 'INSUFFICIENT_BALANCE')).toHaveLength(50);
    expect(results.some((r) => r.status >= 500)).toBe(false);
    expect(await balanceOf(w.walletId)).toBe('0.00');
    await assertLedgerInvariant(db.sql, w.walletId);
  });

  test('3. distinct wallets processed in parallel (20 wallets × 20 operations)', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 20 }, () => openWallet(apps[0]?.url ?? '', '100.00')),
    );
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w) =>
        Array.from({ length: 20 }, (_, i) =>
          submit(tx(w, i % 2 === 0 ? 'BET' : 'WIN', i % 2 === 0 ? '3.00' : '1.00')),
        ),
      ),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe('80.00'); // 100 − 10×3 + 10×1
      await assertLedgerInvariant(db.sql, w.walletId);
    }
    console.log(
      JSON.stringify({ scenario: 'parallel-wallets', operations: 400, elapsedMs: Math.round(elapsed) }),
    );
  });

  test('3b. no global lock: while wallet A is locked, wallet B keeps processing and A waits', async () => {
    const [a, b] = await Promise.all([
      openWallet(apps[0]?.url ?? '', '100.00'),
      openWallet(apps[0]?.url ?? '', '100.00'),
    ]);
    let release: () => void = () => undefined;
    const released = new Promise<void>((r) => {
      release = r;
    });
    // An external transaction holds wallet A's row lock (as a long-running request would).
    const holder = db.sql.begin(async (tx) => {
      await tx`SELECT id FROM wallets WHERE id = ${a.walletId} FOR UPDATE`;
      await released;
    });
    await Bun.sleep(100);
    const onA = submit(tx(a, 'BET', '1.00'));
    const startedB = performance.now();
    const onB = await submit(tx(b, 'BET', '1.00'));
    const elapsedB = performance.now() - startedB;
    expect(onB.body.status).toBe('PROCESSED');
    expect(elapsedB).toBeLessThan(1000);
    // A is still waiting on its own row lock.
    const raced = await Promise.race([onA.then(() => 'done'), Bun.sleep(300).then(() => 'waiting')]);
    expect(raced).toBe('waiting');
    release();
    await holder;
    expect((await onA).body.status).toBe('PROCESSED');
    await assertLedgerInvariant(db.sql, a.walletId);
    await assertLedgerInvariant(db.sql, b.walletId);
  });

  test('4. all three instances served traffic', () => {
    expect(seenInstances).toEqual(new Set(['node-1', 'node-2', 'node-3']));
  });

  test('7. ROLLBACK delivered before its BET (via SQS) is applied once the BET arrives', async () => {
    const w = await openWallet(apps[0]?.url ?? '', '100.00');
    const bet = tx(w, 'BET', '30.00');
    const rollback = tx(w, 'ROLLBACK', '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await sendWager(client, queues.wagerQueueUrl, `m-${rollback.externalTransactionId}`, rollback);
    await waitFor(
      async () =>
        (
          await db.sql`SELECT status FROM wager_transactions WHERE external_transaction_id = ${rollback.externalTransactionId}`
        )[0]?.status === 'PENDING_REFERENCE',
      { what: 'rollback pending' },
    );
    await sendWager(client, queues.wagerQueueUrl, `m-${bet.externalTransactionId}`, bet);
    await waitFor(
      async () =>
        (
          await db.sql`SELECT status FROM wager_transactions WHERE external_transaction_id = ${rollback.externalTransactionId}`
        )[0]?.status === 'PROCESSED',
      { what: 'rollback processed' },
    );
    expect(await balanceOf(w.walletId)).toBe('100.00');
    await assertLedgerInvariant(db.sql, w.walletId);
  });

  test('8. SIGKILL 2 of 3 instances while draining 300 queued messages (with duplicates) → consistent', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 30 }, () => openWallet(apps[0]?.url ?? '', '1000.00')),
    );
    const bodies = wallets.flatMap((w) => Array.from({ length: 10 }, () => tx(w, 'BET', '7.00')));
    await Promise.all(
      bodies.map(async (b) => {
        await sendWager(client, queues.wagerQueueUrl, `m-${b.externalTransactionId}`, b);
        // broker-level duplicate of the same logical message
        await sendWager(client, queues.wagerQueueUrl, `m-${b.externalTransactionId}`, b);
      }),
    );
    await Bun.sleep(700);
    await Promise.all([apps[1]?.kill(), apps[2]?.kill()]);
    await Bun.sleep(500);
    await Promise.all([apps[1]?.start(), apps[2]?.start()]);
    const ids = bodies.map((b) => b.externalTransactionId);
    await waitFor(
      async () =>
        (
          await db.sql`SELECT COUNT(*)::int c FROM wager_transactions WHERE external_transaction_id IN ${db.sql(ids)} AND status = 'PROCESSED'`
        )[0].c === bodies.length,
      { what: 'all queued transactions processed', timeoutMs: 150_000, intervalMs: 500 },
    );
    for (const w of wallets) {
      expect(await balanceOf(w.walletId)).toBe('930.00');
      expect(await debitsOf(w.walletId)).toBe(10);
    }
    await assertLedgerInvariant(db.sql);
    const dupInbox = await db.sql`SELECT COUNT(*)::int c FROM inbox_messages WHERE processed_at IS NULL`;
    expect(dupInbox[0].c).toBe(0);
  });

  test('6. outbox: every committed event is published, by any instance', async () => {
    await waitFor(
      async () =>
        (await db.sql`SELECT COUNT(*)::int c FROM outbox_messages WHERE published_at IS NULL`)[0].c === 0,
      { what: 'outbox drained', timeoutMs: 180_000, intervalMs: 500 },
    );
    const rows = (await db.sql`SELECT id FROM outbox_messages`) as { id: string }[];
    const expected = new Set<string>(rows.map((r) => r.id));
    const published = new Set<string | undefined>();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && [...expected].some((id) => !published.has(id))) {
      for (const m of await drain(client, queues.eventsQueueUrl, 1000))
        published.add(m.MessageAttributes?.eventId?.StringValue);
    }
    const missing = [...expected].filter((id) => !published.has(id));
    expect(missing).toEqual([]);
    console.log(JSON.stringify({ scenario: 'outbox', events: expected.size }));
  });
});

describe('crash between commit and ack', () => {
  test('5. worker dies after commit, before ack → redelivered, deduped by the inbox; events still published', async () => {
    const q = await createTestQueues(client, { visibilityTimeoutSeconds: 2 });
    const w = await openWallet(apps[0]?.url ?? '', '100.00');
    const body = tx(w, 'BET', '15.00');

    // Instance that commits and then exits(97) before deleting the message; its outbox is off,
    // so the committed events are left for another instance to publish.
    const crasher = new AppInstance('crasher', freePort(), {
      databaseUrl: db.url,
      queues: q,
      env: {
        FAULT_CRASH_AFTER_COMMIT: 'true',
        OUTBOX_ENABLED: 'false',
        PENDING_REF_ENABLED: 'false',
        SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
      },
    });
    await crasher.start();
    await sendWager(client, q.wagerQueueUrl, 'crash-msg-1', body);
    expect(await crasher.waitExit(20_000)).toBe(97);

    const committed =
      await db.sql`SELECT id, status FROM wager_transactions WHERE external_transaction_id = ${body.externalTransactionId}`;
    expect(committed[0]?.status).toBe('PROCESSED');
    const unpublished =
      await db.sql`SELECT COUNT(*)::int c FROM outbox_messages WHERE aggregate_id IN (${committed[0]?.id}, ${w.walletId}) AND published_at IS NULL`;
    expect(unpublished[0].c).toBeGreaterThan(0);

    const survivor = new AppInstance('survivor', freePort(), {
      databaseUrl: db.url,
      queues: q,
      env: { SQS_VISIBILITY_TIMEOUT_SECONDS: '2' },
    });
    await survivor.start();
    try {
      await waitFor(async () => survivor.logs.some((l) => l.includes('duplicate message ignored (inbox)')), {
        what: 'redelivery deduplicated',
        timeoutMs: 20_000,
      });
      await waitFor(
        async () =>
          (
            await db.sql`SELECT COUNT(*)::int c FROM outbox_messages WHERE aggregate_id IN (${committed[0]?.id}, ${w.walletId}) AND published_at IS NULL`
          )[0].c === 0,
        { what: 'events published by survivor' },
      );
      expect(await debitsOf(w.walletId)).toBe(1);
      expect(await balanceOf(w.walletId)).toBe('85.00');
      expect((await drain(client, q.wagerQueueUrl, 500)).length).toBe(0);
      await assertLedgerInvariant(db.sql, w.walletId);
    } finally {
      await survivor.terminate();
    }
  });
});
