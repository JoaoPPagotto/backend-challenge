import type { Clock } from '../../shared/application/ports/clock.port';
import type { AppLogger, AppMetrics } from '../../shared/application/ports/observability.port';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.port';
import { FailureCode } from '../../shared/domain/errors/failure-code';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import type { WagerProcessor } from './wager-processor';

export interface PendingReferenceRetryPolicy {
  maxAttempts: number;
  ttlMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  batchSize: number;
}

export interface RetryRunSummary {
  claimed: number;
  processed: number;
  rejected: number;
  stillPending: number;
  skipped: number;
}

/**
 * Re-evaluates PENDING_REFERENCE transactions whose next attempt is due.
 * Exponential backoff per transaction; after `maxAttempts` or `ttlMs` the transaction
 * is REJECTED with REFERENCE_NOT_FOUND and a WagerTransactionRejected event is emitted.
 *
 * Lock order is the same as the main path (wallet → transaction row), so the worker and
 * the request path never deadlock each other. Several workers may run concurrently.
 */
export class RetryPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
    private readonly policy: PendingReferenceRetryPolicy,
  ) {}

  async runOnce(): Promise<RetryRunSummary> {
    const summary: RetryRunSummary = { claimed: 0, processed: 0, rejected: 0, stillPending: 0, skipped: 0 };
    const due = await this.uow.run((r) =>
      r.transactions.claimDuePendingReferences(this.clock.now(), this.policy.batchSize),
    );
    summary.claimed = due.length;
    for (const candidate of due) {
      try {
        const outcome = await this.retryOne(candidate.id, candidate.walletId);
        summary[outcome] += 1;
      } catch (error) {
        this.logger.warn('pending reference retry failed; will retry later', {
          transactionId: candidate.id,
          err: String(error),
        });
      }
    }
    return summary;
  }

  private retryOne(
    transactionId: string,
    walletId: string,
  ): Promise<'processed' | 'rejected' | 'stillPending' | 'skipped'> {
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.lockById(walletId);
      const tx = await repos.transactions.lockById(transactionId);
      const now = this.clock.now();
      if (
        !tx ||
        tx.status !== WagerTransactionStatus.PendingReference ||
        (tx.nextReferenceAttemptAt && tx.nextReferenceAttemptAt.getTime() > now.getTime())
      ) {
        return 'skipped';
      }
      this.metrics.pendingReferenceRetry();
      const expectedVersion = wallet?.version;
      const evaluation = await this.processor.evaluate(tx, wallet, repos);

      if (evaluation.referenceMissing) {
        const attempts = tx.referenceAttempts + 1;
        const expired = now.getTime() - tx.createdAt.getTime() >= this.policy.ttlMs;
        if (attempts >= this.policy.maxAttempts || expired) {
          tx.reject(FailureCode.ReferenceNotFound, now, wallet?.balance);
          this.metrics.pendingReferenceExhausted();
          this.logger.warn('reference never arrived; transaction rejected', {
            transactionId: tx.id,
            walletId: tx.walletId,
            providerId: tx.providerId,
            attempts,
          });
        } else {
          const delay = Math.min(this.policy.baseDelayMs * 2 ** attempts, this.policy.maxDelayMs);
          tx.recordReferenceAttempt(new Date(now.getTime() + delay));
          await repos.transactions.update(tx);
          return 'stillPending';
        }
      }

      await repos.transactions.update(tx);
      await this.processor.persistEffects(tx, wallet, expectedVersion, evaluation, repos, {
        correlationId: tx.id,
        causationId: tx.id,
      });
      const finalStatus = tx.status as WagerTransactionStatus;
      return finalStatus === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
    });
  }
}
