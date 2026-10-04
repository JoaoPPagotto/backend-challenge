import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../../outbox/application/event-publisher.port';
import type { OutboxMessage } from '../../../outbox/domain/outbox-message';

/**
 * Publishes outbox rows to the events FIFO queue.
 * MessageGroupId = aggregateId (per-aggregate order), MessageDeduplicationId = eventId
 * (broker dedup is a bonus inside its 5-minute window — consumers still dedupe by eventId).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: OutboxMessage[]): Promise<PublishResult> {
    const published = new Set<string>();
    const failed = new Set<string>();
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      try {
        const res = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((m, idx) => ({
              Id: String(idx),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: m.eventType },
                eventId: { DataType: 'String', StringValue: m.id },
                correlationId: {
                  DataType: 'String',
                  StringValue: String((m.payload as { correlationId?: unknown }).correlationId ?? m.id),
                },
              },
            })),
          }),
        );
        for (const ok of res.Successful ?? []) {
          const msg = chunk[Number(ok.Id)];
          if (msg) published.add(msg.id);
        }
        for (const ko of res.Failed ?? []) {
          const msg = chunk[Number(ko.Id)];
          if (msg) failed.add(msg.id);
        }
      } catch {
        for (const m of chunk) failed.add(m.id);
      }
    }
    return { published, failed };
  }
}
