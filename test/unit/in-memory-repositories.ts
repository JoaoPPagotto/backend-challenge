import type { InboxMessage } from '../../src/inbox/domain/inbox-message';
import type { OutboxMessage } from '../../src/outbox/domain/outbox-message';
import { WalletConcurrencyError } from '../../src/shared/application/errors/application.errors';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/shared/application/ports/unit-of-work.port';
import { Money } from '../../src/shared/domain/money/money';
import type { WagerTransaction } from '../../src/wagering/domain/wager-transaction';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction-status';
import { Wallet } from '../../src/wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../src/wallet/domain/wallet-ledger-entry';
import { WalletAlreadyExistsError } from '../../src/wallet/domain/wallet.errors';

/**
 * In-memory repositories for UNIT tests of the application layer only. They do not model
 * locking or concurrency — that is exactly what the integration/concurrency suites verify
 * against the real PostgreSQL and SQS.
 */
export class InMemoryStore {
  wallets = new Map<string, Wallet>();
  ledger: WalletLedgerEntry[] = [];
  transactions = new Map<string, WagerTransaction>();
  inbox = new Map<string, InboxMessage>();
  outbox: OutboxMessage[] = [];
}

function cloneWallet(w: Wallet): Wallet {
  return Wallet.rehydrate({
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance.toJSON(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });
}

export function inMemoryRepos(s: InMemoryStore): TransactionalRepositories {
  const txs = () => [...s.transactions.values()];
  return {
    wallets: {
      async insert(w) {
        if ([...s.wallets.values()].some((x) => x.playerId === w.playerId && x.currency === w.currency)) {
          throw new WalletAlreadyExistsError(w.playerId, w.currency);
        }
        s.wallets.set(w.id, cloneWallet(w));
      },
      async findById(id) {
        const w = s.wallets.get(id);
        return w ? cloneWallet(w) : undefined;
      },
      async lockById(id) {
        const w = s.wallets.get(id);
        return w ? cloneWallet(w) : undefined;
      },
      async saveBalance(w, expectedVersion) {
        const cur = s.wallets.get(w.id);
        if (!cur || cur.version !== expectedVersion) throw new WalletConcurrencyError(w.id);
        s.wallets.set(w.id, cloneWallet(w));
      },
    },
    ledger: {
      async append(e) {
        s.ledger.push(e);
      },
      async findByTransactionId(id) {
        return s.ledger.find((e) => e.transactionId === id);
      },
      async page(walletId, afterId, limit) {
        return s.ledger
          .filter((e) => e.walletId === walletId && (!afterId || e.id > afterId))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit);
      },
      async totals(walletId) {
        const entries = s.ledger.filter((e) => e.walletId === walletId);
        const first = entries[0];
        if (!first) return { net: '0', count: 0 };
        const net = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero(first.money.currency));
        return { net: net.toJSON().amount, count: entries.length };
      },
    },
    transactions: {
      async insertIfAbsent(t) {
        if (
          txs().some(
            (x) =>
              x.idempotencyKey === t.idempotencyKey ||
              (x.providerId === t.providerId && x.externalTransactionId === t.externalTransactionId),
          )
        ) {
          return false;
        }
        s.transactions.set(t.id, t);
        return true;
      },
      async update(t) {
        s.transactions.set(t.id, t);
      },
      async findById(id) {
        return s.transactions.get(id);
      },
      async findExisting(key, providerId, ext) {
        return (
          txs().find((x) => x.idempotencyKey === key) ??
          txs().find((x) => x.providerId === providerId && x.externalTransactionId === ext)
        );
      },
      async findByProviderExternal(providerId, ext) {
        return txs().find((x) => x.providerId === providerId && x.externalTransactionId === ext);
      },
      async lockById(id) {
        return s.transactions.get(id);
      },
      async claimDuePendingReferences(now, limit) {
        return txs()
          .filter(
            (x) =>
              x.status === WagerTransactionStatus.PendingReference &&
              (x.nextReferenceAttemptAt?.getTime() ?? 0) <= now.getTime(),
          )
          .slice(0, limit);
      },
      async expediteWaitingOn() {
        return 0;
      },
      async hasProcessedReversal(refId) {
        return txs().some(
          (x) =>
            x.referenceTransactionId === refId &&
            x.isReversal() &&
            x.status === WagerTransactionStatus.Processed,
        );
      },
    },
    inbox: {
      async receive(m) {
        const key = `${m.consumerName}/${m.messageId}`;
        const existing = s.inbox.get(key);
        if (existing) return { message: existing, inserted: false };
        s.inbox.set(key, m);
        return { message: m, inserted: true };
      },
      async markProcessed() {},
    },
    outbox: {
      async enqueue(ms) {
        s.outbox.push(...ms);
      },
      async claimDue() {
        return [];
      },
      async save() {},
      async stats() {
        return { pending: 0, oldestOccurredAt: undefined };
      },
    },
  };
}

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(readonly store = new InMemoryStore()) {}
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    return work(inMemoryRepos(this.store));
  }
  read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    return work(inMemoryRepos(this.store));
  }
}
