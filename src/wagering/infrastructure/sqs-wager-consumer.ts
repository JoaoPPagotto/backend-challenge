import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { TransientInfrastructureError } from '../../shared/application/errors/application.errors';
import type { AppLogger, AppMetrics } from '../../shared/application/ports/observability.port';
import { DomainError, ValidationError } from '../../shared/domain/errors/domain.error';
import { WagerTransactionRequestedSchema } from '../../shared/infrastructure/messaging/sqs-message-contract';
import { RequestContext } from '../../shared/infrastructure/observability/request-context';
import type { MarkTransactionFailedUseCase } from '../application/mark-transaction-failed.usecase';
import type { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.usecase';
import { IdempotencyConflictError } from '../domain/wager-transaction.errors';

export const CONSUMER_NAME = 'wager-transactions-consumer';

export interface SqsConsumerConfig {
  queueUrl: string;
  dlqUrl: string;
  maxReceiveCount: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  concurrency: number;
  shutdownTimeoutMs: number;
  crashAfterCommit: boolean;
}

type Classification = 'ack' | 'retry' | 'dlq';

/**
 * Consumes wager-transactions.fifo with the same use case as HTTP.
 *  - persistent inbox dedup by (consumerName, messageId) inside the business transaction;
 *  - delete (ack) only after the commit;
 *  - business outcomes (processed/rejected/pending/conflict) → ack;
 *  - transient failures → visibility backoff, up to maxReceiveCount, then FAILED + DLQ;
 *  - permanent failures (invalid contract) → DLQ immediately;
 *  - SIGTERM: stop receiving, finish in-flight work, return the rest (visibility 0).
 */
export class SqsWagerConsumer {
  private running = false;
  private abort = new AbortController();
  private loop: Promise<void> | undefined;
  private readonly inFlight = new Map<string, { message: Message; done: Promise<void> }>();

  constructor(
    private readonly client: SQSClient,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly markFailed: MarkTransactionFailedUseCase,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
    private readonly config: SqsConsumerConfig,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    await this.loop?.catch(() => undefined);
    const pending = [...this.inFlight.values()];
    if (pending.length === 0) return;
    this.logger.info('draining in-flight messages', { count: pending.length });
    const drained = Promise.all(pending.map((p) => p.done)).then(() => true);
    const timeout = Bun.sleep(this.config.shutdownTimeoutMs).then(() => false);
    if (await Promise.race([drained, timeout])) return;
    // Not finished in time: give them back to the queue right away.
    await Promise.all(
      [...this.inFlight.values()].map(({ message }) =>
        this.changeVisibility(message, 0).catch((err) =>
          this.logger.warn('could not release message', { messageId: message.MessageId, err: String(err) }),
        ),
      ),
    );
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const res = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.queueUrl,
            MaxNumberOfMessages: Math.min(10, this.config.concurrency),
            WaitTimeSeconds: this.config.waitTimeSeconds,
            VisibilityTimeout: this.config.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
          { abortSignal: this.abort.signal },
        );
        const messages = res.Messages ?? [];
        if (messages.length === 0) continue;
        // FIFO order per group: same group sequentially, different groups in parallel.
        const groups = new Map<string, Message[]>();
        for (const m of messages) {
          const g = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'default';
          groups.set(g, [...(groups.get(g) ?? []), m]);
        }
        await Promise.all(
          [...groups.values()].map(async (group) => {
            for (const m of group) await this.track(m);
          }),
        );
      } catch (error) {
        if (!this.running) break;
        this.logger.warn('sqs receive failed; backing off', { err: String(error) });
        await Bun.sleep(1000);
      }
    }
  }

  private track(message: Message): Promise<void> {
    const key = message.ReceiptHandle ?? message.MessageId ?? String(Math.random());
    const done = this.handle(message).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, { message, done });
    return done;
  }

  /** Visible for tests: handles a single received message end to end. */
  async handle(message: Message): Promise<void> {
    this.metrics.sqsReceived();
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let parsed: ReturnType<typeof WagerTransactionRequestedSchema.safeParse>;
    try {
      parsed = WagerTransactionRequestedSchema.safeParse(JSON.parse(message.Body ?? ''));
    } catch {
      parsed = WagerTransactionRequestedSchema.safeParse(undefined);
    }
    if (!parsed.success) {
      await this.deadLetter(
        message,
        'INVALID_MESSAGE',
        parsed.error.issues.map((i) => i.path.join('.')).join(','),
      );
      return;
    }
    const body = parsed.data;
    const correlationId = message.MessageAttributes?.correlationId?.StringValue ?? body.messageId;
    await RequestContext.run(
      {
        correlationId,
        messageId: body.messageId,
        walletId: body.data.walletId,
        providerId: body.data.providerId,
      },
      async () => {
        const outcome = await this.process(body, correlationId);
        if (outcome.kind === 'ack') {
          if (this.config.crashAfterCommit) {
            this.logger.error('FAULT INJECTION: exiting after commit, before ack', {
              messageId: body.messageId,
            });
            process.exit(97);
          }
          await this.ack(message);
          this.metrics.sqsAcked(outcome.reason);
          return;
        }
        if (outcome.kind === 'dlq') {
          await this.deadLetter(message, outcome.reason, outcome.detail);
          return;
        }
        // retry
        if (receiveCount >= this.config.maxReceiveCount) {
          await this.markFailed
            .execute(body.data)
            .catch((err) => this.logger.warn('could not persist FAILED transaction', { err: String(err) }));
          await this.deadLetter(message, 'RETRIES_EXHAUSTED', outcome.reason);
          return;
        }
        const backoff = Math.min(2 ** receiveCount, 300);
        await this.changeVisibility(message, backoff).catch(() => undefined);
        this.metrics.sqsRetried(outcome.reason);
        this.logger.warn('transient failure; message will be retried', {
          messageId: body.messageId,
          receiveCount,
          backoffSeconds: backoff,
          reason: outcome.reason,
        });
      },
    );
  }

  private async process(
    body: ReturnType<typeof WagerTransactionRequestedSchema.parse>,
    correlationId: string,
  ): Promise<{ kind: Classification; reason: string; detail?: string }> {
    try {
      const { idempotencyKey, ...data } = body.data;
      const result = await this.useCase.execute({
        ...data,
        idempotencyKey,
        context: {
          channel: 'sqs',
          correlationId,
          causationId: body.messageId,
          inbox: { consumerName: CONSUMER_NAME, messageId: body.messageId },
        },
      });
      RequestContext.set({ transactionId: result.transactionId });
      return { kind: 'ack', reason: result.idempotentReplay ? 'replay' : result.status.toLowerCase() };
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        this.logger.warn('idempotency conflict on queue message; acked', { messageId: body.messageId });
        return { kind: 'ack', reason: 'idempotency_conflict' };
      }
      if (error instanceof ValidationError) {
        return { kind: 'dlq', reason: error.code, detail: error.message };
      }
      if (error instanceof DomainError) {
        return { kind: 'dlq', reason: error.code, detail: error.message };
      }
      if (error instanceof TransientInfrastructureError) {
        return { kind: 'retry', reason: error.reason };
      }
      this.logger.error('unexpected error processing message', { messageId: body.messageId }, error);
      return { kind: 'retry', reason: 'unexpected_error' };
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.config.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async deadLetter(message: Message, reason: string, detail?: string): Promise<void> {
    const group = message.Attributes?.MessageGroupId ?? 'dlq';
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.config.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: group,
        MessageDeduplicationId: `${message.MessageId ?? 'unknown'}:dlq`,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          failureDetail: { DataType: 'String', StringValue: (detail ?? '-').slice(0, 1000) || '-' },
          originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
        },
      }),
    );
    await this.ack(message);
    this.metrics.sqsDeadLettered(reason);
    this.logger.warn('message moved to DLQ', { sqsMessageId: message.MessageId, reason });
  }
}
