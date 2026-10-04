import { FailureCode } from '../../shared/domain/errors/failure-code';
import { Money, type MoneyProps } from '../../shared/domain/money/money';
import { LedgerDirection, invertDirection } from '../../wallet/domain/ledger-direction';
import { ALLOWED_REFERENCE_KINDS, WagerTransactionKind } from './wager-transaction-kind';
import { TERMINAL_STATUSES, TRANSITIONS, WagerTransactionStatus } from './wager-transaction-status';
import {
  InvalidTransactionStateError,
  KindNotAllowedError,
  MissingReferenceError,
} from './wager-transaction.errors';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  observedBalance?: MoneyProps | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | undefined;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    /** Wallet balance observed when the decision was taken; returned on idempotent replay. */
    private _observedBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Born PENDING. Validates the reference requirement per kind. Rejects OPENING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new KindNotAllowedError('OPENING is internal and cannot be submitted');
    }
    return WagerTransaction.build(props);
  }

  /** Internal OPENING credit, created already PROCESSED together with the wallet. */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    at: Date;
  }): WagerTransaction {
    const tx = WagerTransaction.build({
      id: props.id,
      providerId: 'system',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `system:opening:${props.walletId}`,
      payloadHash: '0'.repeat(64),
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'system',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
    });
    tx.markProcessed(undefined, props.at, props.money);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance ? Money.from(state.observedBalance) : undefined,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    const hasReference =
      props.referenceExternalTransactionId !== undefined && props.referenceExternalTransactionId !== '';
    if (requiresReference && !hasReference) {
      throw new MissingReferenceError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (hasReference && ALLOWED_REFERENCE_KINDS[props.kind].length === 0) {
      throw new KindNotAllowedError(`${props.kind} cannot reference another transaction`);
    }
    if (props.money.isNegative()) {
      throw new KindNotAllowedError('Transaction amount cannot be negative');
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      hasReference ? props.referenceExternalTransactionId : undefined,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transitions (throw InvalidTransactionStateError when not allowed)

  markProcessed(referenceTransactionId: string | undefined, at: Date, observedBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  markPendingReference(nextAttemptAt: Date, observedBalance: Money | undefined): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  /** Records a failed reference lookup while still PENDING_REFERENCE (not a state change). */
  recordReferenceAttempt(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`Cannot record reference attempt in status ${this._status}`);
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money | undefined): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  affectsBalance(): boolean {
    if (this._status === WagerTransactionStatus.Rejected || this._status === WagerTransactionStatus.Failed) {
      return false;
    }
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK direction requires the referenced transaction');
        }
        return invertDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not move the balance');
    }
  }

  /**
   * Validates a resolved reference against rules 2, 3 and 5 of the challenge.
   * Returns the failure code, or undefined when the reference is acceptable.
   * A reference still in flight (PENDING / PENDING_REFERENCE) is reported as
   * 'NOT_READY' so the caller keeps waiting instead of rejecting.
   */
  checkReference(reference: WagerTransaction): FailureCode | 'NOT_READY' | undefined {
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (!ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind)) {
      return FailureCode.ReferenceKindNotAllowed;
    }
    if (!reference.isTerminal()) {
      return 'NOT_READY';
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (this.isReversal() && !reference.money.equals(this.money)) {
      return FailureCode.AmountMismatch;
    }
    return undefined;
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(
        `Invalid transition ${this._status} → ${next} for transaction ${this.id}`,
      );
    }
    this._status = next;
  }
}
