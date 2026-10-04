import type { IntegrationEvent } from '../../shared/domain/events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  jitterMs: number;
}

export const DEFAULT_OUTBOX_RETRY: RetryPolicy = { baseMs: 1_000, maxMs: 5 * 60_000, jitterMs: 500 };

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** The outbox row id is the event id: consumers dedupe on it. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (this._publishedAt === undefined) this._publishedAt = at;
  }

  /** Increments attempts and computes the next attempt with exponential backoff + jitter. */
  scheduleRetry(
    now: Date,
    policy: RetryPolicy = DEFAULT_OUTBOX_RETRY,
    random: () => number = Math.random,
  ): void {
    this._attempts += 1;
    const exp = Math.min(policy.baseMs * 2 ** (this._attempts - 1), policy.maxMs);
    const delay = exp + Math.floor(random() * policy.jitterMs);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
