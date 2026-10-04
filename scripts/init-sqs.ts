/**
 * Creates the FIFO queues (idempotent). Used by docker compose (`init-sqs` service) and
 * by tests. Works against LocalStack or any SQS-compatible endpoint.
 *
 *   wager-transactions.fifo      → redrive to the DLQ after SQS_MAX_RECEIVE_COUNT receives
 *   wager-transactions-dlq.fifo
 *   wagering-events.fifo         → integration events published by the outbox
 */
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';

export interface QueueSet {
  wagerQueueUrl: string;
  dlqUrl: string;
  eventsQueueUrl: string;
}

export async function createQueues(
  client: SQSClient,
  opts: { prefix?: string; maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<QueueSet> {
  const prefix = opts.prefix ?? '';
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: `${prefix}wager-transactions-dlq.fifo`,
      Attributes: { ...fifo, MessageRetentionPeriod: '1209600' },
    }),
  );
  const dlqUrl = dlq.QueueUrl ?? '';
  const dlqAttrs = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const main = await client.send(
    new CreateQueueCommand({
      QueueName: `${prefix}wager-transactions.fifo`,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(opts.visibilityTimeoutSeconds ?? 30),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttrs.Attributes?.QueueArn,
          maxReceiveCount: String(opts.maxReceiveCount ?? 5),
        }),
      },
    }),
  );
  const events = await client.send(
    new CreateQueueCommand({ QueueName: `${prefix}wagering-events.fifo`, Attributes: fifo }),
  );
  return { wagerQueueUrl: main.QueueUrl ?? '', dlqUrl, eventsQueueUrl: events.QueueUrl ?? '' };
}

if (import.meta.main) {
  const client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
  for (let attempt = 1; ; attempt++) {
    try {
      const urls = await createQueues(client, {
        maxReceiveCount: Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5),
      });
      console.log(JSON.stringify({ msg: 'queues ready', ...urls }));
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      console.log(JSON.stringify({ msg: 'sqs not ready, retrying', attempt }));
      await Bun.sleep(1000);
    }
  }
}
