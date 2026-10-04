import type { OutboxMessage } from '../domain/outbox-message';

export interface PublishResult {
  published: Set<string>;
  failed: Set<string>;
}

/** Transport for integration events. At-least-once: consumers dedupe by eventId. */
export interface EventPublisher {
  publish(messages: OutboxMessage[]): Promise<PublishResult>;
}
