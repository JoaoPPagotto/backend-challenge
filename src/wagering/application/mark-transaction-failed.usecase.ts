import type { Clock } from '../../shared/application/ports/clock.port';
import type { IdGenerator } from '../../shared/application/ports/id-generator.port';
import type { AppLogger } from '../../shared/application/ports/observability.port';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.port';
import { FailureCode } from '../../shared/domain/errors/failure-code';
import { Money, type MoneyProps } from '../../shared/domain/money/money';
import { WagerTransaction } from '../domain/wager-transaction';
import { parseExternalKind } from '../domain/wager-transaction-kind';
import { wagerPayloadHash } from './canonical-json';

export interface FailedTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * Records a FAILED transaction (permanent infrastructure error, terminal and auditable)
 * when a queue message exhausted its retries. Never touches the balance. No-op when the
 * transaction already exists (it was decided by a previous attempt).
 */
export class MarkTransactionFailedUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  async execute(input: FailedTransactionInput): Promise<void> {
    const kind = parseExternalKind(input.kind);
    if (!kind) return;
    const now = this.clock.now();
    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: wagerPayloadHash(input),
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind,
      money: Money.from(input.money),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });
    tx.fail(FailureCode.InfrastructureFailure, now);
    const inserted = await this.uow.run((r) => r.transactions.insertIfAbsent(tx));
    if (inserted) {
      this.logger.error('transaction marked FAILED after exhausting retries', {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
      });
    }
  }
}
