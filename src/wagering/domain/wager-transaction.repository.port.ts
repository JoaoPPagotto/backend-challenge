import type { WagerTransaction } from './wager-transaction';

export interface WagerTransactionRepository {
  /**
   * INSERT … ON CONFLICT DO NOTHING. Returns false when a row with the same
   * idempotency key or (providerId, externalTransactionId) already exists — the
   * transaction stays usable so the caller can resolve replay vs conflict.
   */
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  update(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Row with the same idempotency key, or else the same (providerId, externalTransactionId). */
  findExisting(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Locks the row (FOR UPDATE). */
  lockById(id: string): Promise<WagerTransaction | undefined>;
  /** Due PENDING_REFERENCE ids, claimed with FOR UPDATE SKIP LOCKED. */
  claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]>;
  /**
   * Pulls forward transactions of the same wallet waiting on this reference so they are
   * retried immediately. Restricted to the wallet whose lock the caller holds, keeping a
   * single lock order (wallet → transaction rows) across all code paths.
   */
  expediteWaitingOn(
    walletId: string,
    providerId: string,
    referenceExternalTransactionId: string,
    now: Date,
  ): Promise<number>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
}
