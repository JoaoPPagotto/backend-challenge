import { LockMode, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxMessage } from '../../../inbox/domain/inbox-message';
import type { InboxRepository } from '../../../inbox/domain/inbox.repository.port';
import type { OutboxMessage } from '../../../outbox/domain/outbox-message';
import type { OutboxRepository, OutboxStats } from '../../../outbox/domain/outbox.repository.port';
import type { WagerTransaction } from '../../../wagering/domain/wager-transaction';
import { WagerTransactionStatus } from '../../../wagering/domain/wager-transaction-status';
import type { WagerTransactionRepository } from '../../../wagering/domain/wager-transaction.repository.port';
import type { Wallet } from '../../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../../wallet/domain/wallet-ledger-entry';
import { WalletAlreadyExistsError } from '../../../wallet/domain/wallet.errors';
import type {
  LedgerRepository,
  LedgerTotals,
  WalletRepository,
} from '../../../wallet/domain/wallet.repository.port';
import { WalletConcurrencyError } from '../../application/errors/application.errors';
import { InboxMapper, LedgerMapper, OutboxMapper, WagerTransactionMapper, WalletMapper } from './mappers';
import {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './schemas';

/** Reads never populate the identity map: every write here is an explicit native statement. */
const NO_IM = { disableIdentityMap: true } as const;

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
    } catch (e) {
      if (e instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw e;
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, NO_IM);
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const r = await this.em.findOne(WalletRecord, { id }, { ...NO_IM, lockMode: LockMode.PESSIMISTIC_WRITE });
    return r ? WalletMapper.toDomain(r) : undefined;
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toJSON().amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) throw new WalletConcurrencyError(wallet.id);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, LedgerMapper.toRecord(entry));
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined> {
    const r = await this.em.findOne(LedgerEntryRecord, { transactionId }, NO_IM);
    return r ? LedgerMapper.toDomain(r) : undefined;
  }

  async page(walletId: string, afterId: string | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const where = afterId ? { walletId, id: { $gt: afterId } } : { walletId };
    const rows = await this.em.find(LedgerEntryRecord, where, { ...NO_IM, orderBy: { id: 'asc' }, limit });
    return rows.map(LedgerMapper.toDomain);
  }

  async totals(walletId: string): Promise<LedgerTotals> {
    const rows = await this.em.execute<{ net: string; count: number }[]>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS net,
              COUNT(*)::int AS count
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0];
    return { net: row?.net ?? '0', count: row?.count ?? 0 };
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    const r = WagerTransactionMapper.toRecord(tx);
    const res = await this.em.execute<{ id: string }[]>(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
         status, failure_code, observed_balance, reference_attempts, next_reference_attempt_at, created_at, processed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        r.id,
        r.providerId,
        r.externalTransactionId,
        r.idempotencyKey,
        r.payloadHash,
        r.walletId,
        r.playerId,
        r.roundId,
        r.gameId,
        r.kind,
        r.amount,
        r.currency,
        r.referenceExternalTransactionId ?? null,
        r.referenceTransactionId ?? null,
        r.status,
        r.failureCode ?? null,
        r.observedBalance ?? null,
        r.referenceAttempts,
        r.nextReferenceAttemptAt ?? null,
        r.createdAt,
        r.processedAt ?? null,
      ],
    );
    return res.length === 1;
  }

  async update(tx: WagerTransaction): Promise<void> {
    const r = WagerTransactionMapper.toRecord(tx);
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id },
      {
        status: r.status,
        failureCode: r.failureCode ?? null,
        referenceTransactionId: r.referenceTransactionId ?? null,
        observedBalance: r.observedBalance ?? null,
        referenceAttempts: r.referenceAttempts,
        nextReferenceAttemptAt: r.nextReferenceAttemptAt ?? null,
        processedAt: r.processedAt ?? null,
      },
    );
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { id }, NO_IM);
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async findExisting(
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    // One round trip; a row matching the idempotency key wins over one matching only the external id.
    const rows = await this.em.find(
      WagerTransactionRecord,
      { $or: [{ idempotencyKey }, { providerId, externalTransactionId }] },
      { ...NO_IM, limit: 2 },
    );
    const r = rows.find((x) => x.idempotencyKey === idempotencyKey) ?? rows[0];
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, NO_IM);
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { ...NO_IM, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return r ? WagerTransactionMapper.toDomain(r) : undefined;
  }

  async claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      {
        ...NO_IM,
        orderBy: { nextReferenceAttemptAt: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // FOR UPDATE SKIP LOCKED
      },
    );
    return rows.map(WagerTransactionMapper.toDomain);
  }

  async expediteWaitingOn(
    walletId: string,
    providerId: string,
    referenceExternalTransactionId: string,
    now: Date,
  ): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        walletId,
        status: WagerTransactionStatus.PendingReference,
        providerId,
        referenceExternalTransactionId,
        nextReferenceAttemptAt: { $gt: now },
      },
      { nextReferenceAttemptAt: now },
    );
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async receive(message: InboxMessage): Promise<{ message: InboxMessage; inserted: boolean }> {
    const res = await this.em.execute<{ message_id: string }[]>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    if (res.length === 1) return { message, inserted: true };
    const existing = await this.em.findOneOrFail(
      InboxRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { ...NO_IM, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return { message: InboxMapper.toDomain(existing), inserted: false };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxRecord, messages.map(OutboxMapper.toRecord));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxRecord,
      // next_attempt_at is always set (enqueue = occurredAt), so this walks ix_outbox_pending.
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        ...NO_IM,
        orderBy: { nextAttemptAt: 'asc', occurredAt: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    return rows.map(OutboxMapper.toDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxRecord,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      },
    );
  }

  async stats(): Promise<OutboxStats> {
    const rows = await this.em.execute<{ pending: number; oldest: Date | null }[]>(
      'SELECT COUNT(*)::int AS pending, MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL',
    );
    const row = rows[0];
    return { pending: row?.pending ?? 0, oldestOccurredAt: row?.oldest ? new Date(row.oldest) : undefined };
  }
}
