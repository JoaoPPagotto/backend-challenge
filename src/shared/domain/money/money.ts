import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';

/** Wire / persistence representation. `amount` is always a decimal string with scale 2. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
/** Optional minus, integer part, optional fraction of 1–2 digits. No exponent, no "+", no spaces. */
const AMOUNT_PATTERN = /^-?\d{1,18}(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/**
 * Immutable monetary value. Arithmetic is exact (decimal.js); scale is fixed to 2.
 * `from` accepts negative values because internal values (e.g. reconciliation
 * differences) may be negative — input contracts reject negatives at the edge.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money must be an object { amount, currency }');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Money.amount must be a decimal string');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Invalid money amount: "${amount}"`);
    }
    Money.assertCurrency(currency);
    return new Money(Money.normalize(new D(amount)), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new D(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(Money.normalize(this.value.plus(other.value)), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(Money.normalize(this.value.minus(other.value)), this.currency);
  }

  negate(): Money {
    return new Money(Money.normalize(this.value.negated()), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid ISO-4217 currency: "${String(currency)}"`);
    }
  }

  /** Fixes scale to 2 and folds -0 into 0. Inputs already have ≤ 2 decimals, so no rounding happens. */
  private static normalize(value: Decimal): Decimal {
    const scaled = value.toDecimalPlaces(SCALE);
    return scaled.isZero() ? new D(0) : scaled;
  }
}
