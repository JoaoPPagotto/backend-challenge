import type { OutboxMessage } from './outbox-message';

export interface OutboxStats {
  pending: number;
  oldestOccurredAt: Date | undefined;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /** Due messages claimed with FOR UPDATE SKIP LOCKED (safe with concurrent publishers). */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  stats(): Promise<OutboxStats>;
}
