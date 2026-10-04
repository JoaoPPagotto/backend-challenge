import {
  DeleteMessageBatchCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { type QueueSet, createQueues } from '../../scripts/init-sqs';

/** Real SQS-compatible endpoint (LocalStack in compose; default port of `--profile test`). */
export const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4567';

export function sqsClient(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

/** Fresh set of FIFO queues with a unique prefix, so test files never share a queue. */
export async function createTestQueues(
  client: SQSClient,
  opts: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<QueueSet> {
  const prefix = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-`;
  return createQueues(client, { prefix, ...opts });
}

export interface WagerMessageData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey?: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** Sends a WagerTransactionRequested message. `dedupId` lets tests simulate broker redelivery. */
export async function sendWager(
  client: SQSClient,
  queueUrl: string,
  messageId: string,
  data: WagerMessageData,
  dedupId = `${messageId}:${Math.random().toString(36).slice(2)}`,
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: data.walletId,
      MessageDeduplicationId: dedupId,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          ...data,
          idempotencyKey: data.idempotencyKey ?? `${data.providerId}:${data.externalTransactionId}`,
        },
      }),
    }),
  );
}

/**
 * Drains a queue: receive + delete. Deleting matters on FIFO queues — the next message of
 * a group only becomes visible once the previous one is deleted.
 */
export async function drain(client: SQSClient, queueUrl: string, waitMs = 1500): Promise<Message[]> {
  const out: Message[] = [];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const res = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 600,
        MessageAttributeNames: ['All'],
      }),
    );
    const batch = res.Messages ?? [];
    out.push(...batch);
    if (batch.length === 0) {
      await Bun.sleep(100);
      continue;
    }
    await client.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: batch.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }),
    );
  }
  return out;
}

export async function purge(client: SQSClient, queueUrl: string): Promise<void> {
  await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
}
