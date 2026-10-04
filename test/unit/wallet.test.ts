import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared/domain/money/money';
import { CurrencyMismatchError } from '../../src/shared/domain/money/money.errors';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';
import { Wallet } from '../../src/wallet/domain/wallet';
import { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry';
import {
  InsufficientBalanceError,
  InvalidWalletOperationError,
  ReversalWouldOverdrawError,
  UnbalancedLedgerEntryError,
} from '../../src/wallet/domain/wallet.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const ctx = () => ({ ledgerEntryId: `le-${++seq}`, transactionId: `tx-${seq}`, at });
const open = (amount: string) => Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(amount), at });

describe('Wallet', () => {
  test('opens with version 1 and the initial balance', () => {
    const w = open('100.00');
    expect(w.version).toBe(1);
    expect(w.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(w.currency).toBe('BRL');
  });

  test('cannot open with a negative balance', () => {
    expect(() => open('-1.00')).toThrow(InvalidWalletOperationError);
  });

  test('opening entry credits from zero without changing version', () => {
    const w = open('100.00');
    const e = w.openingEntry(ctx());
    expect(e.direction).toBe(LedgerDirection.Credit);
    expect(e.balanceBefore.isZero()).toBe(true);
    expect(e.balanceAfter.equals(brl('100.00'))).toBe(true);
    expect(w.version).toBe(1);
    expect(() => open('0.00').openingEntry(ctx())).toThrow(InvalidWalletOperationError);
  });

  test('debit returns a balanced entry and bumps version', () => {
    const w = open('100.00');
    const e = w.debit(brl('80.00'), ctx());
    expect(w.balance.toJSON().amount).toBe('20.00');
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect(e.balanceBefore.toJSON().amount).toBe('100.00');
    expect(e.balanceAfter.toJSON().amount).toBe('20.00');
    expect(e.isBalanced()).toBe(true);
    expect(e.walletVersion).toBe(2);
    expect(w.debit(brl('1.00'), ctx()).walletVersion).toBe(3);
  });

  test('debit allows going exactly to zero but never below', () => {
    const w = open('80.00');
    w.debit(brl('80.00'), ctx());
    expect(w.balance.isZero()).toBe(true);
    expect(() => w.debit(brl('0.01'), ctx())).toThrow(InsufficientBalanceError);
    expect(w.version).toBe(2);
    expect(w.balance.isZero()).toBe(true);
  });

  test('credit bumps version', () => {
    const w = open('0.00');
    w.credit(brl('10.50'), ctx());
    expect(w.balance.toJSON().amount).toBe('10.50');
    expect(w.version).toBe(2);
  });

  test('rejects zero/negative movements and other currencies', () => {
    const w = open('10.00');
    expect(() => w.debit(brl('0.00'), ctx())).toThrow(InvalidWalletOperationError);
    expect(() => w.credit(brl('-1.00'), ctx())).toThrow(InvalidWalletOperationError);
    expect(() => w.credit(Money.from({ amount: '1.00', currency: 'USD' }), ctx())).toThrow(
      CurrencyMismatchError,
    );
    expect(w.version).toBe(1);
  });

  test('reverse of a credit debits; overdraw raises a distinct error', () => {
    const w = open('0.00');
    const win = w.credit(brl('50.00'), ctx());
    w.debit(brl('30.00'), ctx());
    expect(() => w.reverse(win, ctx())).toThrow(ReversalWouldOverdrawError);
    expect(w.balance.toJSON().amount).toBe('20.00');
    w.credit(brl('30.00'), ctx());
    const rev = w.reverse(win, ctx());
    expect(rev.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toJSON().amount).toBe('0.00');
  });

  test('reverse of a debit credits', () => {
    const w = open('100.00');
    const bet = w.debit(brl('25.00'), ctx());
    const rev = w.reverse(bet, ctx());
    expect(rev.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe('100.00');
    expect(w.version).toBe(3);
  });

  test('rehydrate restores state without revalidation', () => {
    const w = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: { amount: '12.34', currency: 'BRL' },
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toJSON().amount).toBe('12.34');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    walletVersion: 2,
    createdAt: at,
  };

  test('validates arithmetic in the factory', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('9.99'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('-5.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('0.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('is structurally immutable', () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('10.00'),
    });
    expect(Object.isFrozen(e)).toBe(true);
    expect(Reflect.set(e, 'direction', 'DEBIT')).toBe(false);
    expect(e.direction).toBe(LedgerDirection.Credit);
    expect(e.signedAmount().toJSON().amount).toBe('10.00');
  });
});
