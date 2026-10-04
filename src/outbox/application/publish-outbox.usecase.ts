import type { Clock } from '../../shared/application/ports/clock.port';
import type { AppLogger, AppMetrics } from '../../shared/application/ports/observability.port';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.port';
import type { EventPublisher } from './event-publisher.port';

/**
 * Publishes due outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED inside a
 * transaction, so any number of publishers (one per instance) can run concurrently
 * without picking the same row. If the process dies after sending but before the
 * commit, the row stays unpublished and is sent again: at-least-once, duplicates are
 * harmless because consumers dedupe on eventId (= outbox id = SQS dedup id).
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
    private readonly batchSize: number,
  ) {}

  /** Returns how many rows were handled (published or rescheduled). */
  async runOnce(): Promise<number> {
    const handled = await this.uow.run(async (repos) => {
      const due = await repos.outbox.claimDue(this.clock.now(), this.batchSize);
      if (due.length === 0) return 0;
      let result: Awaited<ReturnType<EventPublisher['publish']>>;
      try {
        result = await this.publisher.publish(due);
      } catch (error) {
        this.logger.warn('outbox publish failed', { count: due.length, err: String(error) });
        result = { published: new Set(), failed: new Set(due.map((m) => m.id)) };
      }
      const now = this.clock.now();
      const lags: number[] = [];
      for (const message of due) {
        if (result.published.has(message.id)) {
          message.markPublished(now);
          lags.push((now.getTime() - message.occurredAt.getTime()) / 1000);
        } else {
          message.scheduleRetry(now);
          this.metrics.outboxPublishFailure();
        }
        await repos.outbox.save(message);
      }
      this.metrics.outboxPublished(lags.length, lags);
      return due.length;
    });
    return handled;
  }

  async refreshStats(): Promise<void> {
    const stats = await this.uow.read((r) => r.outbox.stats());
    const age = stats.oldestOccurredAt
      ? (this.clock.now().getTime() - stats.oldestOccurredAt.getTime()) / 1000
      : 0;
    this.metrics.outboxPending(stats.pending, Math.max(0, age));
  }
}
