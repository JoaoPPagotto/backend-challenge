import type { InboxMessage } from './inbox-message';

export interface InboxRepository {
  /**
   * Inserts the message if absent and returns the persisted row. When another
   * consumer is processing the same message concurrently, this blocks until that
   * transaction ends (unique index), then returns the committed row.
   */
  receive(message: InboxMessage): Promise<{ message: InboxMessage; inserted: boolean }>;
  markProcessed(message: InboxMessage): Promise<void>;
}
