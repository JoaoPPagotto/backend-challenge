import { EntitySchema } from '@mikro-orm/core';

/**
 * Persistence records (data mapper). The domain never sees these: repositories
 * map records ⇄ aggregates through `rehydrate`. Money columns are `numeric(20,2)`
 * read and written as strings.
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  observedBalance?: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

const money = { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' } as const;
const ts = { type: 'Date', columnType: 'timestamptz' } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { ...money },
    version: { type: 'integer' },
    createdAt: { ...ts },
    updatedAt: { ...ts },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    amount: { ...money },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'text' },
    failureCode: { type: 'text', nullable: true },
    observedBalance: { ...money, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceAttemptAt: { ...ts, nullable: true },
    createdAt: { ...ts },
    processedAt: { ...ts, nullable: true },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: { ...money },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { ...money },
    balanceAfter: { ...money },
    walletVersion: { type: 'integer' },
    createdAt: { ...ts },
  },
});

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: { ...ts },
    processedAt: { ...ts, nullable: true },
  },
});

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'text' },
    eventType: { type: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { ...ts },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...ts, nullable: true },
    publishedAt: { ...ts, nullable: true },
  },
});

export const ENTITY_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxSchema,
  OutboxSchema,
];
