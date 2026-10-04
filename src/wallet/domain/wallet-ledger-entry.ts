import { Money, type MoneyProps } from '../../shared/domain/money/money';
import { CurrencyMismatchError } from '../../shared/domain/money/money.errors';
import { LedgerDirection } from './ledger-direction';
import { UnbalancedLedgerEntryError } from './wallet.errors';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version after this entry was applied (opening = 1). Unique per wallet: the ledger is a gapless chain. */
  walletVersion: number;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: Date;
}

/**
 * Immutable ledger line. No mutable fields, no transition methods; the instance
 * is frozen. `create` validates the arithmetic; the database enforces it again
 * (CHECK constraint) and forbids UPDATE/DELETE (trigger).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    if (money.currency !== balanceBefore.currency) {
      throw new CurrencyMismatchError(balanceBefore.currency, money.currency);
    }
    if (money.currency !== balanceAfter.currency) {
      throw new CurrencyMismatchError(balanceAfter.currency, money.currency);
    }
    if (!money.isPositive()) {
      throw new UnbalancedLedgerEntryError('Ledger entry amount must be positive');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new UnbalancedLedgerEntryError('walletVersion must be a positive integer');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError('Ledger balances can never be negative');
    }
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      money,
      balanceBefore,
      balanceAfter,
      props.walletVersion,
      new Date(props.createdAt.getTime()),
    );
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `Unbalanced ledger entry: ${balanceBefore.toString()} ${props.direction} ${money.toString()} != ${balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.money),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect on the balance (credit positive, debit negative). */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
