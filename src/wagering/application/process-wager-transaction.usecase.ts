import { InboxMessage } from '../../inbox/domain/inbox-message';
import type { Clock } from '../../shared/application/ports/clock.port';
import type { IdGenerator } from '../../shared/application/ports/id-generator.port';
import type { AppLogger, AppMetrics, Channel } from '../../shared/application/ports/observability.port';
import type { TransactionalRepositories, UnitOfWork } from '../../shared/application/ports/unit-of-work.port';
import { withRetry } from '../../shared/application/retry';
import { ValidationError } from '../../shared/domain/errors/domain.error';
import type { FailureCode } from '../../shared/domain/errors/failure-code';
import { Money, type MoneyProps } from '../../shared/domain/money/money';
import { WagerTransaction } from '../domain/wager-transaction';
import {
  type ExternalKindValue,
  type ExternalWagerTransactionKind,
  parseExternalKind,
} from '../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import { IdempotencyConflictError, KindNotAllowedError } from '../domain/wager-transaction.errors';
import { wagerPayloadHash } from './canonical-json';
import type { WagerProcessor } from './wager-processor';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: ExternalKindValue;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  context: {
    channel: Channel;
    correlationId: string;
    causationId?: string | undefined;
    /** Present when the command comes from the queue: persistent dedup by (consumerName, messageId). */
    inbox?: { consumerName: string; messageId: string } | undefined;
  };
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Balance observed when the transaction was decided (original value on replay). */
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface PendingReferencePolicy {
  baseDelayMs: number;
}

/**
 * The single entry point for wager transactions — used by HTTP and by the SQS consumer.
 *
 * Inside one SQL transaction: inbox record, wallet row lock, transaction row, ledger
 * entry, conditional balance update and outbox events. Either all commit or none does.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
    private readonly pendingPolicy: PendingReferencePolicy,
  ) {}

  async execute(cmd: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const started = performance.now();
    const kind = parseExternalKind(cmd.kind);
    if (!kind) throw new KindNotAllowedError(`Kind ${String(cmd.kind)} cannot be submitted`);
    const money = Money.from(cmd.money);
    if (!money.isPositive()) throw new ValidationError('money.amount must be greater than zero');
    const payloadHash = wagerPayloadHash(cmd);
    const channel = cmd.context.channel;

    try {
      // Fast path (no lock): an already decided request is answered from the database.
      if (!cmd.context.inbox) {
        const existing = await this.uow.read((r) =>
          r.transactions.findExisting(cmd.idempotencyKey, cmd.providerId, cmd.externalTransactionId),
        );
        if (existing) return this.finish(this.replayOf(existing, cmd, payloadHash), cmd, started);
      }

      const result = await withRetry(
        () => this.uow.run((repos) => this.process(cmd, kind, money, payloadHash, repos)),
        {
          attempts: 3,
          baseDelayMs: 25,
          retryOn: ['wallet_version_conflict', 'deadlock', 'lock_timeout'],
          onRetry: (reason) => {
            this.metrics.lockConflict(reason);
            this.metrics.transientRetry(reason);
          },
        },
      );
      return this.finish(result, cmd, started);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) this.metrics.idempotencyConflict(channel);
      throw error;
    }
  }

  private async process(
    cmd: ProcessWagerTransactionCommand,
    kind: ExternalWagerTransactionKind,
    money: Money,
    payloadHash: string,
    repos: TransactionalRepositories,
  ): Promise<ProcessWagerTransactionResult> {
    const now = this.clock.now();

    let inbox: InboxMessage | undefined;
    if (cmd.context.inbox) {
      const received = await repos.inbox.receive(
        InboxMessage.receive({
          messageId: cmd.context.inbox.messageId,
          consumerName: cmd.context.inbox.consumerName,
          payloadHash,
          receivedAt: now,
        }),
      );
      inbox = received.message;
      if (!received.inserted && inbox.isProcessed()) {
        this.metrics.inboxDuplicate();
        this.logger.info('duplicate message ignored (inbox)', { messageId: inbox.messageId });
        const existing = await repos.transactions.findExisting(
          cmd.idempotencyKey,
          cmd.providerId,
          cmd.externalTransactionId,
        );
        if (existing) return this.replayOf(existing, cmd, payloadHash);
      }
    }

    // Unit of concurrency: the wallet row. Everything below is serialized per wallet.
    const wallet = await repos.wallets.lockById(cmd.walletId);
    const expectedVersion = wallet?.version;

    // Re-check under the lock: another instance may have decided this request meanwhile.
    const existing = await repos.transactions.findExisting(
      cmd.idempotencyKey,
      cmd.providerId,
      cmd.externalTransactionId,
    );
    if (existing) return this.markInbox(repos, inbox, now, this.replayOf(existing, cmd, payloadHash));

    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind,
      money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: now,
    });

    const evaluation = await this.processor.evaluate(tx, wallet, repos);
    if (evaluation.referenceMissing) {
      tx.markPendingReference(new Date(now.getTime() + this.pendingPolicy.baseDelayMs), wallet?.balance);
    }

    // Nothing has been written yet: if the key/external id is taken (a concurrent request on
    // another wallet id with the same key), resolve it as replay or conflict.
    const inserted = await repos.transactions.insertIfAbsent(tx);
    if (!inserted) {
      const winner = await repos.transactions.findExisting(
        cmd.idempotencyKey,
        cmd.providerId,
        cmd.externalTransactionId,
      );
      if (!winner) throw new Error('Transaction insert conflicted but no row was found');
      return this.markInbox(repos, inbox, now, this.replayOf(winner, cmd, payloadHash));
    }

    await this.processor.persistEffects(tx, wallet, expectedVersion, evaluation, repos, {
      correlationId: cmd.context.correlationId,
      causationId: cmd.context.causationId,
    });

    const result: ProcessWagerTransactionResult = {
      transactionId: tx.id,
      status: tx.status,
      balance: tx.observedBalance?.toJSON() ?? null,
      idempotentReplay: false,
    };
    if (tx.failureCode) result.failureCode = tx.failureCode;
    return this.markInbox(repos, inbox, now, result);
  }

  private async markInbox(
    repos: TransactionalRepositories,
    inbox: InboxMessage | undefined,
    now: Date,
    result: ProcessWagerTransactionResult,
  ): Promise<ProcessWagerTransactionResult> {
    if (inbox && !inbox.isProcessed()) {
      inbox.markProcessed(now);
      await repos.inbox.markProcessed(inbox);
    }
    return result;
  }

  /** Same key + same payload → original result. Anything else → conflict (never a replay). */
  private replayOf(
    existing: WagerTransaction,
    cmd: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): ProcessWagerTransactionResult {
    if (existing.idempotencyKey !== cmd.idempotencyKey || !existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(cmd.idempotencyKey, existing.id);
    }
    const result: ProcessWagerTransactionResult = {
      transactionId: existing.id,
      status: existing.status,
      balance: existing.observedBalance?.toJSON() ?? null,
      idempotentReplay: true,
    };
    if (existing.failureCode) result.failureCode = existing.failureCode;
    return result;
  }

  private finish(
    result: ProcessWagerTransactionResult,
    cmd: ProcessWagerTransactionCommand,
    started: number,
  ): ProcessWagerTransactionResult {
    const channel = cmd.context.channel;
    if (result.idempotentReplay) this.metrics.idempotentReplay(channel);
    this.metrics.transactionFinished(
      { kind: cmd.kind, status: result.status, channel },
      (performance.now() - started) / 1000,
    );
    this.logger.info('wager transaction handled', {
      transactionId: result.transactionId,
      walletId: cmd.walletId,
      providerId: cmd.providerId,
      kind: cmd.kind,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
    return result;
  }
}
