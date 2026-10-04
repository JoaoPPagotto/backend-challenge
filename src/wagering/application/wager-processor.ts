import { OutboxMessage } from '../../outbox/domain/outbox-message';
import type { Clock } from '../../shared/application/ports/clock.port';
import type { IdGenerator } from '../../shared/application/ports/id-generator.port';
import type { TransactionalRepositories } from '../../shared/application/ports/unit-of-work.port';
import { InvariantViolationError } from '../../shared/domain/errors/domain.error';
import { FailureCode } from '../../shared/domain/errors/failure-code';
import type { EventContext, IntegrationEvent } from '../../shared/domain/events/integration-event';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { InsufficientBalanceError, ReversalWouldOverdrawError } from '../../wallet/domain/wallet.errors';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './events/wagering-events';

export type ReferenceResolution =
  | { kind: 'ok'; reference: WagerTransaction }
  | { kind: 'missing' }
  | { kind: 'rejected'; code: FailureCode };

export interface Evaluation {
  /** Ledger entry produced (only when the balance changed). */
  entry?: WalletLedgerEntry;
  /** True when the reference is still missing (caller decides: pending or retry/exhaust). */
  referenceMissing: boolean;
}

export interface MessageContext {
  correlationId: string;
  causationId?: string | undefined;
}

/**
 * Applies the business rules of section 7 to a transaction while the caller holds
 * the wallet row lock. Shared by the HTTP/SQS use case and the pending-reference worker,
 * so both paths behave identically.
 */
export class WagerProcessor {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async resolveReference(
    tx: WagerTransaction,
    repos: TransactionalRepositories,
  ): Promise<ReferenceResolution> {
    const refExternalId = tx.referenceExternalTransactionId;
    if (refExternalId === undefined) return { kind: 'missing' };
    const reference = await repos.transactions.findByProviderExternal(tx.providerId, refExternalId);
    if (!reference) return { kind: 'missing' };
    const check = tx.checkReference(reference);
    if (check === 'NOT_READY') return { kind: 'missing' };
    if (check !== undefined) return { kind: 'rejected', code: check };
    if (tx.isReversal() && (await repos.transactions.hasProcessedReversal(reference.id))) {
      return { kind: 'rejected', code: FailureCode.ReferenceAlreadyReversed };
    }
    return { kind: 'ok', reference };
  }

  /**
   * Mutates `tx` (status) and `wallet` (balance) in memory. Nothing is persisted here.
   * When the reference is missing, `tx` is left untouched and `referenceMissing` is true.
   */
  async evaluate(
    tx: WagerTransaction,
    wallet: Wallet | undefined,
    repos: TransactionalRepositories,
  ): Promise<Evaluation> {
    const now = this.clock.now();
    if (!wallet) {
      tx.reject(FailureCode.WalletNotFound, now, undefined);
      return { referenceMissing: false };
    }
    if (wallet.playerId !== tx.playerId) {
      tx.reject(FailureCode.WalletPlayerMismatch, now, wallet.balance);
      return { referenceMissing: false };
    }
    if (wallet.currency !== tx.money.currency) {
      tx.reject(FailureCode.CurrencyMismatch, now, wallet.balance);
      return { referenceMissing: false };
    }

    let reference: WagerTransaction | undefined;
    if (tx.hasReference()) {
      const resolution = await this.resolveReference(tx, repos);
      if (resolution.kind === 'missing') return { referenceMissing: true };
      if (resolution.kind === 'rejected') {
        tx.reject(resolution.code, now, wallet.balance);
        return { referenceMissing: false };
      }
      reference = resolution.reference;
    }

    const movement = { ledgerEntryId: this.ids.next(), transactionId: tx.id, at: now };
    try {
      let entry: WalletLedgerEntry | undefined;
      switch (tx.kind) {
        case WagerTransactionKind.Bet:
          entry = wallet.debit(tx.money, movement);
          break;
        case WagerTransactionKind.Win:
        case WagerTransactionKind.Refund:
          entry = wallet.credit(tx.money, movement);
          break;
        case WagerTransactionKind.Rollback: {
          if (!reference) throw new InvariantViolationError('ROLLBACK without resolved reference');
          const original = await repos.ledger.findByTransactionId(reference.id);
          if (!original) {
            throw new InvariantViolationError(
              `Processed ${reference.kind} ${reference.id} has no ledger entry`,
            );
          }
          entry = wallet.reverse(original, movement);
          break;
        }
        case WagerTransactionKind.Loss:
          entry = undefined;
          break;
        case WagerTransactionKind.Opening:
          throw new InvariantViolationError('OPENING is never evaluated');
      }
      tx.markProcessed(reference?.id, now, wallet.balance);
      return entry ? { entry, referenceMissing: false } : { referenceMissing: false };
    } catch (error) {
      if (error instanceof InsufficientBalanceError || error instanceof ReversalWouldOverdrawError) {
        tx.reject(error.code, now, wallet.balance);
        return { referenceMissing: false };
      }
      throw error;
    }
  }

  /** Writes ledger, balance and outbox for an evaluated transaction (the row itself is written by the caller). */
  async persistEffects(
    tx: WagerTransaction,
    wallet: Wallet | undefined,
    expectedVersion: number | undefined,
    evaluation: Evaluation,
    repos: TransactionalRepositories,
    msg: MessageContext,
  ): Promise<void> {
    if (evaluation.entry) {
      if (!wallet || expectedVersion === undefined) throw new InvariantViolationError('Entry without wallet');
      await repos.ledger.append(evaluation.entry);
      await repos.wallets.saveBalance(wallet, expectedVersion);
    }

    const events: IntegrationEvent<unknown>[] = [];
    const ctx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: msg.correlationId,
      causationId: msg.causationId,
      occurredAt: this.clock.now(),
    });
    switch (tx.status) {
      case WagerTransactionStatus.Processed:
        if (!wallet) throw new InvariantViolationError('Processed transaction without wallet');
        events.push(WagerTransactionProcessed.from(tx, wallet.balance, ctx()));
        if (evaluation.entry) events.push(WalletBalanceChanged.from(wallet, evaluation.entry, ctx()));
        break;
      case WagerTransactionStatus.Rejected:
        if (tx.failureCode) events.push(WagerTransactionRejected.from(tx, tx.failureCode, ctx()));
        break;
      case WagerTransactionStatus.PendingReference:
        events.push(WagerTransactionPendingReference.from(tx, ctx()));
        break;
      default:
        break;
    }
    await repos.outbox.enqueue(events.map((e) => OutboxMessage.enqueue(e)));

    if (tx.status === WagerTransactionStatus.Processed) {
      // Anything waiting on this transaction as a reference can be retried right away.
      await repos.transactions.expediteWaitingOn(
        tx.walletId,
        tx.providerId,
        tx.externalTransactionId,
        this.clock.now(),
      );
    }
  }
}
