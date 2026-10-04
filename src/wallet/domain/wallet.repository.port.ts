import type { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletRepository {
  /** @throws WalletAlreadyExistsError on (playerId, currency) conflict */
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /** Row lock (SELECT … FOR UPDATE) — the unit of concurrency is the wallet. */
  lockById(id: string): Promise<Wallet | undefined>;
  /** Conditional update guarded by version. @throws WalletConcurrencyError when 0 rows match. */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface LedgerTotals {
  /** Σ credits − Σ debits, decimal string. */
  net: string;
  count: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined>;
  /** Stable keyset page ordered by id (uuid v7). */
  page(walletId: string, afterId: string | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  totals(walletId: string): Promise<LedgerTotals>;
}
