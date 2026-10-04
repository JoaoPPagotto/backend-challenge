import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../config/app-config';

export function createSqsClient(
  config: Pick<AppConfig, 'AWS_REGION' | 'AWS_ENDPOINT_URL' | 'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY'>,
): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    ...(config.AWS_ENDPOINT_URL ? { endpoint: config.AWS_ENDPOINT_URL } : {}),
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
    maxAttempts: 3,
  });
}

export interface QueueUrls {
  wager: string;
  dlq: string;
  events: string;
}

/**
 * Explicit URLs win; otherwise the URL is looked up by name. Resolving by name keeps the
 * app independent of the URL format of the SQS emulator (LocalStack/MiniStack versions differ).
 */
export async function resolveQueueUrls(
  client: SQSClient,
  config: Pick<
    AppConfig,
    | 'SQS_WAGER_QUEUE_URL'
    | 'SQS_WAGER_DLQ_URL'
    | 'SQS_EVENTS_QUEUE_URL'
    | 'SQS_WAGER_QUEUE_NAME'
    | 'SQS_WAGER_DLQ_NAME'
    | 'SQS_EVENTS_QUEUE_NAME'
  >,
  timeoutMs = 60_000,
): Promise<QueueUrls> {
  const deadline = Date.now() + timeoutMs;
  const resolve = async (url: string | undefined, name: string): Promise<string> => {
    if (url) return url;
    for (;;) {
      try {
        const res = await client.send(new GetQueueUrlCommand({ QueueName: name }));
        if (res.QueueUrl) return res.QueueUrl;
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`Queue ${name} not available: ${String(error)}`);
      }
      await Bun.sleep(1000);
    }
  };
  const [wager, dlq, events] = await Promise.all([
    resolve(config.SQS_WAGER_QUEUE_URL, config.SQS_WAGER_QUEUE_NAME),
    resolve(config.SQS_WAGER_DLQ_URL, config.SQS_WAGER_DLQ_NAME),
    resolve(config.SQS_EVENTS_QUEUE_URL, config.SQS_EVENTS_QUEUE_NAME),
  ]);
  return { wager, dlq, events };
}
