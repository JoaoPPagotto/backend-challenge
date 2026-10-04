import { Money, type MoneyProps } from '../../shared/domain/money/money';
import { CurrencyMismatchError } from '../../shared/domain/money/money.errors';
import { LedgerDirection, invertDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';
import {
  InsufficientBalanceError,
  InvalidWalletOperationError,
  ReversalWouldOverdrawError,
} from './wallet.errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Everything a balance movement needs besides the amount. */
export interface MovementContext {
  ledgerEntryId: string;
  transactionId: string;
  at: Date;
}

/**
 * Aggregate root. The only way to change the balance is through debit/credit/reverse,
 * and each of them returns the ledger entry describing the change — a balance change
 * without its ledger entry is impossible by construction.
 *
 * `version` starts at 1 and increments only when the balance changes; the repository
 * uses it as an optimistic guard on top of the pessimistic row lock.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet. The opening balance is the initial state (version = 1);
   * when positive, the caller records it via `openingEntry` (OPENING transaction).
   */
  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('Initial balance cannot be negative');
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstruction from persistence — no rule is revalidated. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Ledger entry for the opening credit (balance 0 → initial). Does not change state. */
  openingEntry(ctx: MovementContext): WalletLedgerEntry {
    if (!this._balance.isPositive()) {
      throw new InvalidWalletOperationError('Opening entry requires a positive initial balance');
    }
    return WalletLedgerEntry.create({
      id: ctx.ledgerEntryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      walletVersion: 1,
      createdAt: ctx.at,
    });
  }

  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovable(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientBalanceError(this.id);
    }
    return this.apply(LedgerDirection.Debit, money, ctx);
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovable(money);
    return this.apply(LedgerDirection.Credit, money, ctx);
  }

  /** Applies the inverse of a previously recorded entry (ROLLBACK). */
  reverse(original: WalletLedgerEntry, ctx: MovementContext): WalletLedgerEntry {
    if (original.walletId !== this.id) {
      throw new InvalidWalletOperationError('Cannot reverse an entry of another wallet');
    }
    this.assertMovable(original.money);
    const direction = invertDirection(original.direction);
    if (direction === LedgerDirection.Debit && this._balance.isLessThan(original.money)) {
      throw new ReversalWouldOverdrawError(this.id);
    }
    return this.apply(direction, original.money, ctx);
  }

  private apply(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: ctx.ledgerEntryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: ctx.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError('Movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
