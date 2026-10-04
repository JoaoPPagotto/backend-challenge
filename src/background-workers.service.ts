import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Core } from './composition';
import { PublishOutboxUseCase } from './outbox/application/publish-outbox.usecase';
import { PollingLoop } from './shared/application/polling-loop';
import { APP_CONFIG, type AppConfig } from './shared/infrastructure/config/app-config';
import type { QueueUrls } from './shared/infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from './shared/infrastructure/messaging/sqs-event-publisher';
import { CORE, QUEUE_URLS, SQS_CLIENT } from './tokens';
import { MarkTransactionFailedUseCase } from './wagering/application/mark-transaction-failed.usecase';
import { SqsWagerConsumer } from './wagering/infrastructure/sqs-wager-consumer';

/**
 * Background work of an instance: SQS consumer, outbox publisher and pending-reference
 * worker. Every instance runs all three; correctness under concurrency comes from the
 * database (inbox PK, row locks, SKIP LOCKED), not from electing a single worker.
 */
@Injectable()
export class BackgroundWorkers
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private consumer: SqsWagerConsumer | undefined;
  private readonly loops: PollingLoop[] = [];

  constructor(
    @Inject(CORE) private readonly core: Core,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(QUEUE_URLS) private readonly queues: QueueUrls,
  ) {}

  onApplicationBootstrap(): void {
    const { core, config } = this;
    if (config.OUTBOX_ENABLED) {
      const publish = new PublishOutboxUseCase(
        core.uow,
        new SqsEventPublisher(this.sqs, this.queues.events),
        core.clock,
        core.logger,
        core.metrics,
        config.OUTBOX_BATCH,
      );
      this.loops.push(
        new PollingLoop(
          'outbox-publisher',
          config.OUTBOX_POLL_MS,
          async () => {
            const handled = await publish.runOnce();
            await publish.refreshStats();
            return handled >= config.OUTBOX_BATCH;
          },
          core.logger,
        ),
      );
    }
    if (config.PENDING_REF_ENABLED) {
      this.loops.push(
        new PollingLoop(
          'pending-reference-worker',
          config.PENDING_REF_POLL_MS,
          async () => (await core.retryPendingReferences.runOnce()).claimed >= 100,
          core.logger,
        ),
      );
    }
    for (const loop of this.loops) loop.start();

    if (config.SQS_CONSUMER_ENABLED) {
      this.consumer = new SqsWagerConsumer(
        this.sqs,
        core.processWagerTransaction,
        new MarkTransactionFailedUseCase(core.uow, core.ids, core.clock, core.logger),
        core.logger,
        core.metrics,
        {
          queueUrl: this.queues.wager,
          dlqUrl: this.queues.dlq,
          maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
          waitTimeSeconds: config.SQS_WAIT_TIME_SECONDS,
          visibilityTimeoutSeconds: config.SQS_VISIBILITY_TIMEOUT_SECONDS,
          concurrency: config.SQS_CONSUMER_CONCURRENCY,
          shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS,
          crashAfterCommit: config.FAULT_CRASH_AFTER_COMMIT,
        },
      );
      this.consumer.start();
    }
    core.logger.info('background workers started', {
      sqsConsumer: config.SQS_CONSUMER_ENABLED,
      outbox: config.OUTBOX_ENABLED,
      pendingReference: config.PENDING_REF_ENABLED,
    });
  }

  /** SIGTERM: stop taking new work, finish (or give back) in-flight messages. */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.core.logger.info('shutting down background workers', { signal });
    await this.consumer?.stop();
    await Promise.all(this.loops.map((l) => l.stop()));
  }

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.core.close();
    this.core.logger.info('shutdown complete');
  }
}
