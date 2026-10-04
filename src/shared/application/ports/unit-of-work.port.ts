import type { InboxRepository } from '../../../inbox/domain/inbox.repository.port';
import type { OutboxRepository } from '../../../outbox/domain/outbox.repository.port';
import type { WagerTransactionRepository } from '../../../wagering/domain/wager-transaction.repository.port';
import type { LedgerRepository, WalletRepository } from '../../../wallet/domain/wallet.repository.port';

/** Repositories bound to a single SQL transaction. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /**
   * Runs `work` inside one SQL transaction: everything commits together or nothing does.
   * Infrastructure failures are translated to TransientInfrastructureError.
   */
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
  /** Read-only access outside an explicit transaction (autocommit). */
  read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
