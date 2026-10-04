export type LogFields = Record<string, string | number | boolean | undefined | null>;

/** Structured logger. Never pass monetary values or full payloads. */
export interface AppLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields, err?: unknown): void;
}
export const APP_LOGGER = Symbol('AppLogger');

export type Channel = 'http' | 'sqs' | 'worker';

export interface AppMetrics {
  transactionFinished(
    labels: { kind: string; status: string; channel: Channel },
    durationSeconds: number,
  ): void;
  idempotentReplay(channel: Channel): void;
  idempotencyConflict(channel: Channel): void;
  inboxDuplicate(): void;
  lockConflict(reason: string): void;
  transientRetry(reason: string): void;
  pendingReferenceRetry(): void;
  pendingReferenceExhausted(): void;
  reconciliationDivergence(): void;
  sqsReceived(): void;
  sqsAcked(outcome: string): void;
  sqsRetried(reason: string): void;
  sqsDeadLettered(reason: string): void;
  outboxPublished(count: number, lagSeconds: number[]): void;
  outboxPublishFailure(): void;
  outboxPending(count: number, oldestAgeSeconds: number): void;
}
export const APP_METRICS = Symbol('AppMetrics');

export class NoopMetrics implements AppMetrics {
  transactionFinished(
    _labels: { kind: string; status: string; channel: Channel },
    _durationSeconds: number,
  ): void {}
  idempotentReplay(_channel: Channel): void {}
  idempotencyConflict(_channel: Channel): void {}
  inboxDuplicate(): void {}
  lockConflict(_reason: string): void {}
  transientRetry(_reason: string): void {}
  pendingReferenceRetry(): void {}
  pendingReferenceExhausted(): void {}
  reconciliationDivergence(): void {}
  sqsReceived(): void {}
  sqsAcked(_outcome: string): void {}
  sqsRetried(_reason: string): void {}
  sqsDeadLettered(_reason: string): void {}
  outboxPublished(_count: number, _lagSeconds: number[]): void {}
  outboxPublishFailure(): void {}
  outboxPending(_count: number, _oldestAgeSeconds: number): void {}
}

export class NoopLogger implements AppLogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
