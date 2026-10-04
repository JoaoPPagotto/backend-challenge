import { expect } from 'bun:test';
import type { SQL } from 'bun';

/**
 * Final invariant of every integration/concurrency test:
 *   wallet.balance == balance rebuilt from the ledger
 *   wallet.version == 1 + number of non-opening entries (gapless chain)
 *   ≤ 1 ledger entry per transaction
 */
export async function assertLedgerInvariant(sql: SQL, walletId?: string): Promise<void> {
  const rows = (await sql`
    SELECT w.id,
           w.balance::text AS balance,
           w.version,
           COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS rebuilt,
           COUNT(l.id) FILTER (WHERE l.wallet_version > 1)::int AS movements,
           COALESCE(MAX(l.wallet_version), 1)::int AS max_version
      FROM wallets w
      LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     WHERE (${walletId ?? null}::uuid IS NULL OR w.id = ${walletId ?? null}::uuid)
     GROUP BY w.id`) as {
    id: string;
    balance: string;
    version: number;
    rebuilt: string;
    movements: number;
    max_version: number;
  }[];
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect({ wallet: r.id, balance: r.balance }).toEqual({ wallet: r.id, balance: r.rebuilt });
    expect({ wallet: r.id, version: r.version }).toEqual({ wallet: r.id, version: 1 + r.movements });
    expect(r.max_version).toBe(r.version);
  }
  const dup = (await sql`
    SELECT transaction_id FROM wallet_ledger_entries GROUP BY transaction_id HAVING COUNT(*) > 1`) as unknown[];
  expect(dup).toEqual([]);
  const negative = (await sql`SELECT id FROM wallets WHERE balance < 0`) as unknown[];
  expect(negative).toEqual([]);
}
