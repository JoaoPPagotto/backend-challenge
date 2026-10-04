import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/domain/money/money.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('serializes with fixed scale 2', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(brl('0.01').toJSON().amount).toBe('0.01');
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });

  test('normalizes zero variants (including -0) to 0.00', () => {
    for (const z of ['0', '0.0', '00.00', '-0.00', '-0']) {
      const m = brl(z);
      expect(m.toJSON().amount).toBe('0.00');
      expect(m.isZero()).toBe(true);
      expect(m.isNegative()).toBe(false);
    }
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E3'],
    ['1.5e2'],
    [''],
    [' 1.00'],
    ['1.00 '],
    ['+1.00'],
    ['1.005'],
    ['1.'],
    ['.5'],
    ['1,00'],
    ['abc'],
    ['0x10'],
    ['1_000.00'],
  ])('rejects invalid amount %p', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects non-string amounts (no number for money)', () => {
    // A JSON payload with a numeric amount — exactly what a careless client would send.
    const fromWire: { amount: string; currency: string } = JSON.parse('{"amount": 25, "currency": "BRL"}');
    expect(() => Money.from(fromWire)).toThrow(InvalidMoneyError);
  });

  test.each([['brl'], ['BR'], ['BRLL'], [''], ['R$ ']])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('exact decimal arithmetic (no float drift)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
    expect(brl('999999999999999999.99').subtract(brl('0.01')).toJSON().amount).toBe('999999999999999999.98');
    let acc = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) acc = acc.add(brl('0.01'));
    expect(acc.toJSON().amount).toBe('10.00');
  });

  test('negate and sign queries', () => {
    const m = brl('5.00');
    expect(m.negate().toJSON().amount).toBe('-5.00');
    expect(m.negate().isNegative()).toBe(true);
    expect(m.isPositive()).toBe(true);
    expect(m.negate().negate().equals(m)).toBe(true);
    expect(brl('-1.50').isNegative()).toBe(true);
  });

  test('comparisons', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
    expect(brl('2.00').isGreaterThan(brl('1.99'))).toBe(true);
    expect(brl('1.0').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('1.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('operations across currencies throw a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('zero()', () => {
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
    expect(() => Money.zero('usd')).toThrow(InvalidMoneyError);
  });
});
