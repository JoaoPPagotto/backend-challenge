import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { QueueSet } from '../../scripts/init-sqs';
import type { EventPublisher } from '../../src/outbox/application/event-publisher.port';
import { PublishOutboxUseCase } from '../../src/outbox/application/publish-outbox.usecase';
import { TransientInfrastructureError } from '../../src/shared/application/errors/application.errors';
import { NoopMetrics } from '../../src/shared/application/ports/observability.port';
import type { UnitOfWork } from '../../src/shared/application/ports/unit-of-work.port';
import { SqsEventPublisher } from '../../src/shared/infrastructure/messaging/sqs-event-publisher';
import { MarkTransactionFailedUseCase } from '../../src/wagering/application/mark-transaction-failed.usecase';
import { ProcessWagerTransactionUseCase } from '../../src/wagering/application/process-wager-transaction.usecase';
import { SqsWagerConsumer } from '../../src/wagering/infrastructure/sqs-wager-consumer';
import { type CoreHarness, brl, createCore, uniq } from '../setup/core-factory';
import { waitFor } from '../setup/instances';
import { assertLedgerInvariant } from '../setup/invariants';
import { createTestQueues, drain, sendWager, sqsClient } from '../setup/test-sqs';

class CountingMetrics extends NoopMetrics {
  inboxDuplicates = 0;
  dlq: string[] = [];
  retried: string[] = [];
  override inboxDuplicate(): void {
    this.inboxDuplicates++;
  }
  override sqsDeadLettered(reason: string): void {
    this.dlq.push(reason);
  }
  override sqsRetried(reason: string): void {
    this.retried.push(reason);
  }
}

let h: CoreHarness;
let client: SQSClient;
beforeAll(async () => {
  h = await createCore();
  client = sqsClient();
});
afterAll(async () => {
  await assertLedgerInvariant(h.db.sql);
  await h.close();
});

async function newWallet(amount: string) {
  const playerId = crypto.randomUUID();
  const w = await h.core.openWallet.execute({ playerId, initialBalance: brl(amount), correlationId: 'c' });
  return { walletId: w.id, playerId };
}

function data(
  w: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, string> = {},
) {
  return {
    providerId: 'provider-q',
    externalTransactionId: uniq('q'),
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'r',
    gameId: 'g',
    kind,
    money: brl(amount),
    ...extra,
  };
}

function consumer(
  queues: QueueSet,
  opts: {
    uow?: UnitOfWork;
    maxReceiveCount?: number;
    shutdownTimeoutMs?: number;
    metrics?: CountingMetrics;
  } = {},
) {
  const metrics = opts.metrics ?? new CountingMetrics();
  const useCase = new ProcessWagerTransactionUseCase(
    opts.uow ?? h.core.uow,
    h.core.processor,
    h.core.ids,
    h.core.clock,
    h.core.logger,
    metrics,
    { baseDelayMs: 10 },
  );
  const c = new SqsWagerConsumer(
    client,
    useCase,
    new MarkTransactionFailedUseCase(h.core.uow, h.core.ids, h.core.clock, h.core.logger),
    h.core.logger,
    metrics,
    {
      queueUrl: queues.wagerQueueUrl,
      dlqUrl: queues.dlqUrl,
      maxReceiveCount: opts.maxReceiveCount ?? 5,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 5,
      concurrency: 10,
      shutdownTimeoutMs: opts.shutdownTimeoutMs ?? 5000,
      crashAfterCommit: false,
    },
  );
  return { consumer: c, metrics };
}

const txStatus = async (ext: string) =>
  ((
    await h.db.sql`SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = ${ext}`
  )[0] ?? null) as { status: string; failure_code: string | null } | null;

describe('SQS consumer', () => {
  test('redelivered message (same messageId 3×) is applied once; inbox records it', async () => {
    const queues = await createTestQueues(client);
    const w = await newWallet('100.00');
    const d = data(w, 'BET', '10.00');
    for (let i = 0; i < 3; i++) await sendWager(client, queues.wagerQueueUrl, 'dup-msg-1', d);
    const { consumer: c, metrics } = consumer(queues);
    c.start();
    await waitFor(async () => metrics.inboxDuplicates >= 2, { what: 'duplicates detected' });
    await c.stop();
    const ledger = await h.db
      .sql`SELECT COUNT(*)::int c FROM wallet_ledger_entries WHERE wallet_id = ${w.walletId}`;
    expect(ledger[0].c).toBe(2); // opening + one debit
    const [inbox] = await h.db
      .sql`SELECT processed_at IS NOT NULL AS processed FROM inbox_messages WHERE message_id = 'dup-msg-1'`;
    expect(inbox.processed).toBe(true);
    expect((await drain(client, queues.wagerQueueUrl, 500)).length).toBe(0);
    await assertLedgerInvariant(h.db.sql, w.walletId);
  });

  test('business rejection is acked (not retried, not DLQ)', async () => {
    const queues = await createTestQueues(client);
    const w = await newWallet('1.00');
    const d = data(w, 'BET', '10.00');
    await sendWager(client, queues.wagerQueueUrl, uniq('m'), d);
    const { consumer: c, metrics } = consumer(queues);
    c.start();
    await waitFor(async () => (await txStatus(d.externalTransactionId))?.status === 'REJECTED', {
      what: 'rejection',
    });
    await c.stop();
    expect(metrics.dlq).toEqual([]);
    expect((await drain(client, queues.dlqUrl, 300)).length).toBe(0);
  });

  test('invalid contract goes straight to the DLQ with a reason (permanent error)', async () => {
    const queues = await createTestQueues(client);
    const w = await newWallet('1.00');
    await sendWager(client, queues.wagerQueueUrl, uniq('m'), { ...data(w, 'BET', '1.00'), kind: 'OPENING' });
    await sendWager(client, queues.wagerQueueUrl, uniq('m'), {
      ...data(w, 'BET', '1.00'),
      money: brl('1e5'),
    });
    const { consumer: c, metrics } = consumer(queues);
    c.start();
    await waitFor(async () => metrics.dlq.length >= 2, { what: 'dlq' });
    await c.stop();
    const dlq = await drain(client, queues.dlqUrl, 500);
    expect(dlq.map((m) => m.MessageAttributes?.failureReason?.StringValue)).toEqual([
      'INVALID_MESSAGE',
      'INVALID_MESSAGE',
    ]);
  });

  test('transient failure is retried with backoff, then processed exactly once', async () => {
    const queues = await createTestQueues(client);
    const w = await newWallet('100.00');
    const d = data(w, 'BET', '10.00');
    let failuresLeft = 1;
    const flakyUow: UnitOfWork = {
      read: (work) => h.core.uow.read(work),
      run: async (work) => {
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new TransientInfrastructureError('database unavailable', 'db_connection');
        }
        return h.core.uow.run(work);
      },
    };
    await sendWager(client, queues.wagerQueueUrl, uniq('m'), d);
    const { consumer: c, metrics } = consumer(queues, { uow: flakyUow });
    c.start();
    await waitFor(async () => (await txStatus(d.externalTransactionId))?.status === 'PROCESSED', {
      what: 'processed after retry',
      timeoutMs: 15_000,
    });
    await c.stop();
    expect(metrics.retried).toEqual(['db_connection']);
    await assertLedgerInvariant(h.db.sql, w.walletId);
  });

  test('retries exhausted → transaction FAILED (auditable) and message in DLQ', async () => {
    const queues = await createTestQueues(client);
    const w = await newWallet('100.00');
    const d = data(w, 'BET', '10.00');
    const downUow: UnitOfWork = {
      read: (work) => h.core.uow.read(work),
      run: async () => {
        throw new TransientInfrastructureError('database unavailable', 'db_connection');
      },
    };
    await sendWager(client, queues.wagerQueueUrl, uniq('m'), d);
    const { consumer: c, metrics } = consumer(queues, { uow: downUow, maxReceiveCount: 2 });
    c.start();
    await waitFor(async () => metrics.dlq.includes('RETRIES_EXHAUSTED'), {
      what: 'exhaustion',
      timeoutMs: 20_000,
    });
    await c.stop();
    expect(await txStatus(d.externalTransactionId)).toEqual({
      status: 'FAILED',
      failure_code: 'INFRASTRUCTURE_FAILURE',
    });
    const ledger = await h.db
      .sql`SELECT COUNT(*)::int c FROM wallet_ledger_entries WHERE wallet_id = ${w.walletId}`;
    expect(ledger[0].c).toBe(1);
    const dlq = await drain(client, queues.dlqUrl, 500);
    expect(dlq[0]?.MessageAttributes?.failureReason?.StringValue).toBe('RETRIES_EXHAUSTED');
  });

  test('SIGTERM drains in-flight work; what does not finish in time is given back', async () => {
    const queues = await createTestQueues(client);
    const w = await newWallet('100.00');
    const d1 = data(w, 'BET', '1.00');
    const slowUow = (ms: number): UnitOfWork => ({
      read: (work) => h.core.uow.read(work),
      run: async (work) => {
        await Bun.sleep(ms);
        return h.core.uow.run(work);
      },
    });
    // 1) Drain: the in-flight message completes and is acked during stop().
    await sendWager(client, queues.wagerQueueUrl, uniq('m'), d1);
    const a = consumer(queues, { uow: slowUow(800) });
    a.consumer.start();
    await waitFor(async () => (await h.db.sql`SELECT 1 FROM inbox_messages LIMIT 1`).length >= 0 && true, {
      timeoutMs: 100,
    }).catch(() => undefined);
    await Bun.sleep(1300);
    await a.consumer.stop();
    expect((await txStatus(d1.externalTransactionId))?.status).toBe('PROCESSED');
    expect((await drain(client, queues.wagerQueueUrl, 300)).length).toBe(0);

    // 2) Timeout: still running after shutdownTimeoutMs → visibility reset, another consumer completes it.
    const d2 = data(w, 'BET', '2.00');
    await sendWager(client, queues.wagerQueueUrl, uniq('m'), d2);
    const b = consumer(queues, { uow: slowUow(3000), shutdownTimeoutMs: 100 });
    b.consumer.start();
    await Bun.sleep(1300);
    await b.consumer.stop();
    const c = consumer(queues);
    c.consumer.start();
    await waitFor(async () => (await txStatus(d2.externalTransactionId))?.status === 'PROCESSED', {
      what: 'message taken over',
      timeoutMs: 15_000,
    });
    await Bun.sleep(2500); // let the slow, abandoned attempt finish too
    await c.consumer.stop();
    const debits = await h.db.sql`
      SELECT COUNT(*)::int c FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id
       WHERE t.external_transaction_id = ${d2.externalTransactionId}`;
    expect(debits[0].c).toBe(1);
    await assertLedgerInvariant(h.db.sql, w.walletId);
  });
});

describe('transactional outbox', () => {
  test('concurrent publishers never publish the same row twice (SKIP LOCKED)', async () => {
    const queues = await createTestQueues(client);
    const w = await newWallet('10000.00');
    await h.db.sql`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`;
    const ops = Array.from({ length: 60 }, () => data(w, 'BET', '1.00'));
    for (const op of ops) {
      await h.core.processWagerTransaction.execute({
        ...op,
        kind: 'BET',
        idempotencyKey: `${op.providerId}:${op.externalTransactionId}`,
        context: { channel: 'http', correlationId: 'c' },
      });
    }
    const expected = (await h.db.sql`SELECT id FROM outbox_messages WHERE published_at IS NULL`).map(
      (r: { id: string }) => r.id,
    );
    expect(expected.length).toBe(120); // processed + balance changed per bet

    const calls = new Map<string, number>();
    const sqsPublisher = new SqsEventPublisher(client, queues.eventsQueueUrl);
    const counting: EventPublisher = {
      publish: async (messages) => {
        for (const m of messages) calls.set(m.id, (calls.get(m.id) ?? 0) + 1);
        await Bun.sleep(20);
        return sqsPublisher.publish(messages);
      },
    };
    const publishers = Array.from(
      { length: 3 },
      () => new PublishOutboxUseCase(h.core.uow, counting, h.core.clock, h.core.logger, h.core.metrics, 10),
    );
    await Promise.all(
      publishers.map(async (p) => {
        while ((await p.runOnce()) > 0) {
          // keep draining
        }
      }),
    );
    expect([...calls.values()].every((c) => c === 1)).toBe(true);
    expect(new Set(calls.keys())).toEqual(new Set(expected));
    const remaining = await h.db.sql`SELECT COUNT(*)::int c FROM outbox_messages WHERE published_at IS NULL`;
    expect(remaining[0].c).toBe(0);
    const onQueue = await drain(client, queues.eventsQueueUrl, 2500);
    expect(new Set(onQueue.map((m) => m.MessageAttributes?.eventId?.StringValue))).toEqual(new Set(expected));
  });

  test('crash after sending but before commit → event re-sent later; duplicates are identifiable by eventId', async () => {
    const queues = await createTestQueues(client);
    const w = await newWallet('10.00');
    await h.db.sql`UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL`;
    const op = data(w, 'BET', '1.00');
    await h.core.processWagerTransaction.execute({
      ...op,
      kind: 'BET',
      idempotencyKey: `${op.providerId}:${op.externalTransactionId}`,
      context: { channel: 'http', correlationId: 'c' },
    });
    const sqsPublisher = new SqsEventPublisher(client, queues.eventsQueueUrl);
    const crashing: EventPublisher = {
      publish: async (messages) => {
        await sqsPublisher.publish(messages); // the broker got them…
        throw new Error('process died before commit'); // …but the DB never learns it
      },
    };
    const first = new PublishOutboxUseCase(
      h.core.uow,
      crashing,
      h.core.clock,
      h.core.logger,
      h.core.metrics,
      50,
    );
    await first.runOnce();
    const pendingAfterCrash = await h.db
      .sql`SELECT COUNT(*)::int c, MAX(attempts)::int a FROM outbox_messages WHERE published_at IS NULL`;
    expect(pendingAfterCrash[0]).toEqual({ c: 2, a: 1 });

    await h.db.sql`UPDATE outbox_messages SET next_attempt_at = now() WHERE published_at IS NULL`;
    const second = new PublishOutboxUseCase(
      h.core.uow,
      sqsPublisher,
      h.core.clock,
      h.core.logger,
      h.core.metrics,
      50,
    );
    expect(await second.runOnce()).toBe(2);
    const remaining = await h.db.sql`SELECT COUNT(*)::int c FROM outbox_messages WHERE published_at IS NULL`;
    expect(remaining[0].c).toBe(0);
    const onQueue = await drain(client, queues.eventsQueueUrl, 1500);
    const ids = onQueue.map((m) => m.MessageAttributes?.eventId?.StringValue);
    // At-least-once: 2 distinct events, possibly delivered more than once — a consumer dedupes by eventId.
    expect(new Set(ids).size).toBe(2);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });
});
