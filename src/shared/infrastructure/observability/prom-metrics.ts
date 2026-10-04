import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { AppMetrics, Channel } from '../../application/ports/observability.port';

export class PromMetrics implements AppMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions handled, by kind, final status and channel',
    labelNames: ['kind', 'status', 'channel'] as const,
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'transaction_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager transaction',
    labelNames: ['kind', 'channel'] as const,
    buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly replays = new Counter({
    name: 'idempotent_replays_total',
    help: 'Duplicate requests answered with the original result',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });
  private readonly conflicts = new Counter({
    name: 'idempotency_conflicts_total',
    help: 'Same idempotency key reused with a different payload',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });
  private readonly inboxDuplicates = new Counter({
    name: 'inbox_duplicates_total',
    help: 'Redelivered queue messages detected by the persistent inbox',
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wallet_lock_conflicts_total',
    help: 'Wallet concurrency conflicts (version conflict, deadlock, lock timeout)',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly transientRetries = new Counter({
    name: 'transient_retries_total',
    help: 'In-process retries of transient infrastructure failures',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly pendingRefRetries = new Counter({
    name: 'pending_reference_retries_total',
    help: 'Re-evaluations of PENDING_REFERENCE transactions',
    registers: [this.registry],
  });
  private readonly pendingRefExhausted = new Counter({
    name: 'pending_reference_exhausted_total',
    help: 'PENDING_REFERENCE transactions rejected after exhausting retries/TTL',
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliations where stored balance != ledger balance',
    registers: [this.registry],
  });
  private readonly sqsReceivedC = new Counter({
    name: 'sqs_messages_received_total',
    help: 'Messages received from the wager queue',
    registers: [this.registry],
  });
  private readonly sqsAckedC = new Counter({
    name: 'sqs_messages_acked_total',
    help: 'Messages deleted from the queue after commit',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  private readonly sqsRetriedC = new Counter({
    name: 'sqs_messages_retried_total',
    help: 'Messages returned to the queue for retry (visibility backoff)',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly sqsDlqC = new Counter({
    name: 'sqs_messages_dlq_total',
    help: 'Messages moved to the dead-letter queue',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly outboxPublishedC = new Counter({
    name: 'outbox_published_total',
    help: 'Integration events published from the outbox',
    registers: [this.registry],
  });
  private readonly outboxFailuresC = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Outbox publish attempts that failed and were rescheduled',
    registers: [this.registry],
  });
  private readonly outboxPendingG = new Gauge({
    name: 'outbox_pending',
    help: 'Unpublished outbox messages',
    registers: [this.registry],
  });
  private readonly outboxOldestG = new Gauge({
    name: 'outbox_oldest_pending_age_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });
  private readonly outboxLagH = new Histogram({
    name: 'outbox_lag_seconds',
    help: 'Time between event occurrence (commit) and publication',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });

  constructor(defaultMetrics = true) {
    if (defaultMetrics) collectDefaultMetrics({ register: this.registry });
  }

  transactionFinished(l: { kind: string; status: string; channel: Channel }, seconds: number): void {
    this.transactions.inc(l);
    this.duration.observe({ kind: l.kind, channel: l.channel }, seconds);
  }
  idempotentReplay(channel: Channel): void {
    this.replays.inc({ channel });
  }
  idempotencyConflict(channel: Channel): void {
    this.conflicts.inc({ channel });
  }
  inboxDuplicate(): void {
    this.inboxDuplicates.inc();
  }
  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }
  transientRetry(reason: string): void {
    this.transientRetries.inc({ reason });
  }
  pendingReferenceRetry(): void {
    this.pendingRefRetries.inc();
  }
  pendingReferenceExhausted(): void {
    this.pendingRefExhausted.inc();
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
  sqsReceived(): void {
    this.sqsReceivedC.inc();
  }
  sqsAcked(outcome: string): void {
    this.sqsAckedC.inc({ outcome });
  }
  sqsRetried(reason: string): void {
    this.sqsRetriedC.inc({ reason });
  }
  sqsDeadLettered(reason: string): void {
    this.sqsDlqC.inc({ reason });
  }
  outboxPublished(count: number, lagSeconds: number[]): void {
    this.outboxPublishedC.inc(count);
    for (const lag of lagSeconds) this.outboxLagH.observe(lag);
  }
  outboxPublishFailure(): void {
    this.outboxFailuresC.inc();
  }
  outboxPending(count: number, oldestAgeSeconds: number): void {
    this.outboxPendingG.set(count);
    this.outboxOldestG.set(oldestAgeSeconds);
  }
}
