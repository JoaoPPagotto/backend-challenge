import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../src/shared/domain/errors/failure-code';
import { Money } from '../../src/shared/domain/money/money';
import { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { WagerTransactionKind as K } from '../../src/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus as S, TRANSITIONS } from '../../src/wagering/domain/wager-transaction-status';
import {
  InvalidTransactionStateError,
  KindNotAllowedError,
  MissingReferenceError,
} from '../../src/wagering/domain/wager-transaction.errors';
import { LedgerDirection } from '../../src/wallet/domain/ledger-direction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
let n = 0;
function make(kind: K, extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  n++;
  return WagerTransaction.create({
    id: `id-${n}`,
    providerId: 'prov',
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `prov:ext-${n}`,
    payloadHash: 'h'.repeat(64),
    walletId: 'w',
    playerId: 'p',
    roundId: 'r',
    gameId: 'g',
    kind,
    money: brl('10.00'),
    createdAt: at,
    ...extra,
  });
}

describe('WagerTransaction.create', () => {
  test('is born PENDING', () => {
    expect(make(K.Bet).status).toBe(S.Pending);
  });

  test('REFUND and ROLLBACK require a reference', () => {
    expect(() => make(K.Refund)).toThrow(MissingReferenceError);
    expect(() => make(K.Rollback, { referenceExternalTransactionId: '' })).toThrow(MissingReferenceError);
    expect(make(K.Refund, { referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
  });

  test('BET may not reference; WIN may optionally reference', () => {
    expect(() => make(K.Bet, { referenceExternalTransactionId: 'x' })).toThrow(KindNotAllowedError);
    expect(make(K.Win).hasReference()).toBe(false);
    expect(make(K.Win, { referenceExternalTransactionId: 'x' }).hasReference()).toBe(true);
  });

  test('OPENING cannot be created from outside', () => {
    expect(() => make(K.Opening)).toThrow(KindNotAllowedError);
    const o = WagerTransaction.createOpening({
      id: 'o',
      walletId: 'w',
      playerId: 'p',
      money: brl('1.00'),
      at,
    });
    expect(o.status).toBe(S.Processed);
    expect(o.kind).toBe(K.Opening);
  });

  test('missing reference error carries REFERENCE_REQUIRED', () => {
    try {
      make(K.Rollback);
    } catch (e) {
      expect((e as MissingReferenceError).code).toBe(FailureCode.ReferenceRequired);
    }
  });
});

describe('state machine', () => {
  const allStatuses = Object.values(S);

  test('transition table: terminal states have no outgoing transitions', () => {
    expect(TRANSITIONS[S.Processed]).toEqual([]);
    expect(TRANSITIONS[S.Rejected]).toEqual([]);
    expect(TRANSITIONS[S.Failed]).toEqual([]);
  });

  test.each(['processed', 'rejected', 'failed'] as const)(
    'a %s transaction cannot transition again',
    (terminal) => {
      const tx = make(K.Bet);
      if (terminal === 'processed') tx.markProcessed(undefined, at, brl('0.00'));
      if (terminal === 'rejected') tx.reject(FailureCode.InsufficientBalance, at, brl('0.00'));
      if (terminal === 'failed') tx.fail(FailureCode.InfrastructureFailure, at);
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, at, brl('0.00'))).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.AmountMismatch, at, undefined)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.fail(FailureCode.InfrastructureFailure, at)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference(at, undefined)).toThrow(InvalidTransactionStateError);
    },
  );

  test('PENDING → PENDING_REFERENCE → PROCESSED', () => {
    const tx = make(K.Rollback, { referenceExternalTransactionId: 'b' });
    tx.markPendingReference(at, undefined);
    expect(tx.status).toBe(S.PendingReference);
    tx.recordReferenceAttempt(new Date(at.getTime() + 1000));
    expect(tx.referenceAttempts).toBe(1);
    expect(() => tx.markPendingReference(at, undefined)).toThrow(InvalidTransactionStateError);
    tx.markProcessed('ref-id', at, brl('5.00'));
    expect(tx.status).toBe(S.Processed);
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.processedAt).toEqual(at);
    expect(() => tx.recordReferenceAttempt(at)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE → REJECTED keeps failure code', () => {
    const tx = make(K.Refund, { referenceExternalTransactionId: 'b' });
    tx.markPendingReference(at, undefined);
    tx.reject(FailureCode.ReferenceNotFound, at, undefined);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(allStatuses).toContain(tx.status);
  });
});

describe('domain queries', () => {
  test('affectsBalance', () => {
    expect(make(K.Bet).affectsBalance()).toBe(true);
    expect(make(K.Loss).affectsBalance()).toBe(false);
    const rejected = make(K.Bet);
    rejected.reject(FailureCode.InsufficientBalance, at, undefined);
    expect(rejected.affectsBalance()).toBe(false);
  });

  test('ledgerDirectionFor', () => {
    expect(make(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(K.Refund, { referenceExternalTransactionId: 'x' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    const rb = make(K.Rollback, { referenceExternalTransactionId: 'x' });
    expect(rb.ledgerDirectionFor(make(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(make(K.Win))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(make(K.Refund, { referenceExternalTransactionId: 'y' }))).toBe(
      LedgerDirection.Debit,
    );
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => make(K.Loss).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('matchesPayload', () => {
    const tx = make(K.Bet, { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('abd')).toBe(false);
  });
});

describe('checkReference (rules 2, 3, 5)', () => {
  const processedBet = (extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) => {
    const b = make(K.Bet, extra);
    b.markProcessed(undefined, at, brl('90.00'));
    return b;
  };
  const refund = (extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) =>
    make(K.Refund, { referenceExternalTransactionId: 'x', ...extra });
  const rollback = () => make(K.Rollback, { referenceExternalTransactionId: 'x' });

  test('accepts a matching processed BET', () => {
    expect(refund().checkReference(processedBet())).toBeUndefined();
    expect(rollback().checkReference(processedBet())).toBeUndefined();
  });

  test('REFUND only references BET; ROLLBACK references BET/WIN/REFUND', () => {
    const win = make(K.Win);
    win.markProcessed(undefined, at, brl('1.00'));
    const loss = make(K.Loss);
    loss.markProcessed(undefined, at, brl('1.00'));
    expect(refund().checkReference(win)).toBe(FailureCode.ReferenceKindNotAllowed);
    expect(rollback().checkReference(win)).toBeUndefined();
    expect(rollback().checkReference(loss)).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test('must belong to same provider, player, wallet, currency and round', () => {
    expect(refund().checkReference(processedBet({ providerId: 'other' }))).toBe(
      FailureCode.ReferenceMismatch,
    );
    expect(refund().checkReference(processedBet({ playerId: 'other' }))).toBe(FailureCode.ReferenceMismatch);
    expect(refund().checkReference(processedBet({ walletId: 'other' }))).toBe(FailureCode.ReferenceMismatch);
    expect(refund().checkReference(processedBet({ roundId: 'other' }))).toBe(FailureCode.ReferenceMismatch);
    expect(
      refund().checkReference(processedBet({ money: Money.from({ amount: '10.00', currency: 'USD' }) })),
    ).toBe(FailureCode.ReferenceMismatch);
  });

  test('amount must be equal (no partial reversal)', () => {
    expect(refund({ money: brl('9.99') }).checkReference(processedBet())).toBe(FailureCode.AmountMismatch);
  });

  test('reference not processed', () => {
    const rejected = make(K.Bet);
    rejected.reject(FailureCode.InsufficientBalance, at, undefined);
    expect(refund().checkReference(rejected)).toBe(FailureCode.ReferenceNotProcessed);
    expect(refund().checkReference(make(K.Bet))).toBe('NOT_READY');
  });
});
