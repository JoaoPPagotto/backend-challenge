import { InboxMessage } from '../../../inbox/domain/inbox-message';
import { OutboxMessage } from '../../../outbox/domain/outbox-message';
import { WagerTransaction } from '../../../wagering/domain/wager-transaction';
import type { WagerTransactionKind } from '../../../wagering/domain/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../../wagering/domain/wager-transaction-status';
import type { LedgerDirection } from '../../../wallet/domain/ledger-direction';
import { Wallet } from '../../../wallet/domain/wallet';
import { WalletLedgerEntry } from '../../../wallet/domain/wallet-ledger-entry';
import type { FailureCode } from '../../domain/errors/failure-code';
import type {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './schemas';

/** numeric(20,2) may come back as "25" or "25.5" depending on driver settings; Money normalizes. */
const m = (amount: string, currency: string) => ({ amount: String(amount), currency: currency.trim() });
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency.trim(),
      balance: m(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.toJSON().amount,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const LedgerMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: m(r.amount, r.currency),
      balanceBefore: m(r.balanceBefore, r.currency),
      balanceAfter: m(r.balanceAfter, r.currency),
      walletVersion: r.walletVersion,
      createdAt: r.createdAt,
    });
  },
  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.toJSON().amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.toJSON().amount,
      balanceAfter: e.balanceAfter.toJSON().amount,
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: m(r.amount, r.currency),
      referenceExternalTransactionId: opt(r.referenceExternalTransactionId),
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: opt(r.referenceTransactionId),
      failureCode: opt(r.failureCode) as FailureCode | undefined,
      processedAt: opt(r.processedAt),
      observedBalance:
        r.observedBalance === null || r.observedBalance === undefined
          ? undefined
          : m(r.observedBalance, r.currency),
      referenceAttempts: r.referenceAttempts,
      nextReferenceAttemptAt: opt(r.nextReferenceAttemptAt),
    });
  },
  toRecord(t: WagerTransaction): WagerTransactionRecord {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.toJSON().amount,
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      status: t.status,
      failureCode: t.failureCode ?? null,
      observedBalance: t.observedBalance?.toJSON().amount ?? null,
      referenceAttempts: t.referenceAttempts,
      nextReferenceAttemptAt: t.nextReferenceAttemptAt ?? null,
      createdAt: t.createdAt,
      processedAt: t.processedAt ?? null,
    };
  },
};

export const InboxMapper = {
  toDomain(r: InboxRecord): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: r.messageId,
      consumerName: r.consumerName,
      payloadHash: r.payloadHash,
      receivedAt: r.receivedAt,
      processedAt: opt(r.processedAt),
    });
  },
};

export const OutboxMapper = {
  toDomain(r: OutboxRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: opt(r.nextAttemptAt),
      publishedAt: opt(r.publishedAt),
    });
  },
  toRecord(o: OutboxMessage): OutboxRecord {
    return {
      id: o.id,
      aggregateId: o.aggregateId,
      eventType: o.eventType,
      payload: { ...o.payload },
      occurredAt: o.occurredAt,
      attempts: o.attempts,
      nextAttemptAt: o.nextAttemptAt ?? null,
      publishedAt: o.publishedAt ?? null,
    };
  },
};
