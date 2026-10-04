import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import { buildOrmConfig } from '../../src/shared/infrastructure/persistence/mikro-orm.config';
import { type TestDatabase, createEmptyDatabase, createTestDatabase } from '../setup/test-db';

/**
 * The guarantees of section 6 live in the schema: these tests bypass the application
 * entirely and talk SQL to prove the database itself refuses invalid states.
 */

describe('migrations', () => {
  test('up on empty DB, full down, and up again', async () => {
    const db = await createEmptyDatabase();
    const orm = await MikroORM.init(buildOrmConfig(db.url, 2));
    try {
      const migrator = orm.getMigrator();
      expect((await migrator.up()).length).toBe(1);
      const tables = async () =>
        (
          await db.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations' ORDER BY 1`
        ).map((r: { table_name: string }) => r.table_name);
      expect(await tables()).toEqual([
        'inbox_messages',
        'outbox_messages',
        'wager_transactions',
        'wallet_ledger_entries',
        'wallets',
      ]);
      await migrator.down({ to: 0 });
      expect(await tables()).toEqual([]);
      await migrator.up();
      expect((await tables()).length).toBe(5);
    } finally {
      await orm.close(true);
      await db.drop();
    }
  });
});

describe('constraints', () => {
  let db: TestDatabase;
  let sql: SQL;
  beforeAll(async () => {
    db = await createTestDatabase('schema');
    sql = db.sql;
  });
  afterAll(async () => {
    await db.drop();
  });

  /** Bun SQL queries are lazy thenables: wrap them so `expect().rejects` actually runs them. */
  const exec = (q: PromiseLike<unknown>): Promise<unknown> => Promise.resolve(q);
  const uuid = () => Bun.randomUUIDv7();
  const now = new Date();

  /** Runs statements in a transaction that is always committed (deferred checks run). */
  async function inTx(fn: (tx: SQL) => Promise<unknown>) {
    await sql.begin(async (tx) => {
      await fn(tx);
    });
  }

  async function wallet(balance = '0.00', currency = 'BRL') {
    const id = uuid();
    const txId = uuid();
    await inTx(async (tx) => {
      await tx`INSERT INTO wallets VALUES (${id}, ${uuid()}, ${currency}, ${balance}, 1, ${now}, ${now})`;
      if (balance !== '0.00') {
        await tx`INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at)
          VALUES (${txId}, 'system', ${`o:${id}`}, ${`k:${id}`}, ${'0'.repeat(64)}, ${id}, ${uuid()}, 'opening', 'system',
          'OPENING', ${balance}, ${currency}, 'PROCESSED', ${now}, ${now})`;
        await tx`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${id}, ${txId}, 'CREDIT', ${balance}, ${currency}, 0, ${balance}, 1, ${now})`;
      }
    });
    return id;
  }

  async function wagerTx(walletId: string, extra: Record<string, unknown> = {}) {
    const id = uuid();
    const row = {
      id,
      provider_id: 'p',
      external_transaction_id: uuid(),
      idempotency_key: uuid(),
      payload_hash: 'a'.repeat(64),
      wallet_id: walletId,
      player_id: uuid(),
      round_id: 'r',
      game_id: 'g',
      kind: 'BET',
      amount: '1.00',
      currency: 'BRL',
      status: 'PROCESSED',
      created_at: now,
      processed_at: now,
      ...extra,
    };
    await sql`INSERT INTO wager_transactions ${sql(row)}`;
    return id;
  }

  test('balance can never be negative', async () => {
    const id = await wallet();
    await expect(exec(sql`UPDATE wallets SET balance = -0.01 WHERE id = ${id}`)).rejects.toThrow(
      /check constraint/,
    );
  });

  test('one wallet per (player, currency)', async () => {
    const player = uuid();
    await inTx((tx) => tx`INSERT INTO wallets VALUES (${uuid()}, ${player}, 'BRL', 0, 1, ${now}, ${now})`);
    await expect(
      inTx((tx) => tx`INSERT INTO wallets VALUES (${uuid()}, ${player}, 'BRL', 0, 1, ${now}, ${now})`),
    ).rejects.toThrow(/uq_wallets_player_currency/);
  });

  test('wallet opened with balance but no opening entry is refused at commit', async () => {
    await expect(
      inTx((tx) => tx`INSERT INTO wallets VALUES (${uuid()}, ${uuid()}, 'BRL', 10, 1, ${now}, ${now})`),
    ).rejects.toThrow(/without opening ledger entry/);
  });

  test('balance change without ledger entry is refused at commit', async () => {
    const id = await wallet('10.00');
    await expect(
      inTx((tx) => tx`UPDATE wallets SET balance = 5, version = 2 WHERE id = ${id}`),
    ).rejects.toThrow(/without matching ledger entry/);
    await expect(inTx((tx) => tx`UPDATE wallets SET balance = 5 WHERE id = ${id}`)).rejects.toThrow(
      /bump version/,
    );
    await expect(inTx((tx) => tx`UPDATE wallets SET version = 9 WHERE id = ${id}`)).rejects.toThrow(
      /version changed/,
    );
  });

  test('balance change with matching entry commits', async () => {
    const id = await wallet('10.00');
    const t = await wagerTx(id);
    await inTx(async (tx) => {
      await tx`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${id}, ${t}, 'DEBIT', 4, 'BRL', 10, 6, 2, ${now})`;
      await tx`UPDATE wallets SET balance = 6, version = 2 WHERE id = ${id}`;
    });
    const [w] = await sql`SELECT balance::text, version FROM wallets WHERE id = ${id}`;
    expect(w).toEqual({ balance: '6.00', version: 2 });
  });

  test('ledger arithmetic is checked', async () => {
    const id = await wallet('10.00');
    const t = await wagerTx(id);
    await expect(
      exec(
        sql`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${id}, ${t}, 'DEBIT', 4, 'BRL', 10, 7, 2, ${now})`,
      ),
    ).rejects.toThrow(/ck_ledger_balanced/);
    await expect(
      exec(
        sql`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${id}, ${t}, 'DEBIT', 0, 'BRL', 10, 10, 2, ${now})`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  test('at most one ledger entry per transaction and per wallet version', async () => {
    const id = await wallet('10.00');
    const t = await wagerTx(id);
    const t2 = await wagerTx(id);
    await inTx(async (tx) => {
      await tx`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${id}, ${t}, 'DEBIT', 1, 'BRL', 10, 9, 2, ${now})`;
      await tx`UPDATE wallets SET balance = 9, version = 2 WHERE id = ${id}`;
    });
    await expect(
      exec(
        sql`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${id}, ${t}, 'DEBIT', 1, 'BRL', 9, 8, 3, ${now})`,
      ),
    ).rejects.toThrow(/uq_ledger_transaction/);
    await expect(
      exec(
        sql`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${id}, ${t2}, 'DEBIT', 1, 'BRL', 9, 8, 2, ${now})`,
      ),
    ).rejects.toThrow(/uq_ledger_wallet_version/);
  });

  test('ledger currency must match the wallet currency', async () => {
    const id = await wallet('10.00');
    const t = await wagerTx(id);
    await expect(
      exec(
        sql`INSERT INTO wallet_ledger_entries VALUES (${uuid()}, ${id}, ${t}, 'CREDIT', 1, 'USD', 10, 11, 2, ${now})`,
      ),
    ).rejects.toThrow(/fk_ledger_wallet_currency/);
  });

  test('ledger is append-only: UPDATE, DELETE and TRUNCATE are blocked', async () => {
    const id = await wallet('10.00');
    await expect(
      exec(sql`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ${id}`),
    ).rejects.toThrow(/append-only/);
    await expect(exec(sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${id}`)).rejects.toThrow(
      /append-only/,
    );
    await expect(exec(sql`TRUNCATE wallet_ledger_entries CASCADE`)).rejects.toThrow(/append-only/);
  });

  test('wallets cannot be deleted', async () => {
    const id = await wallet();
    await expect(exec(sql`DELETE FROM wallets WHERE id = ${id}`)).rejects.toThrow(/cannot be deleted/);
  });

  test('idempotency key and (provider, external id) are unique', async () => {
    const id = await wallet();
    await wagerTx(id, { idempotency_key: 'k-1', external_transaction_id: 'e-1' });
    await expect(wagerTx(id, { idempotency_key: 'k-1' })).rejects.toThrow(/uq_wt_idempotency_key/);
    await expect(wagerTx(id, { external_transaction_id: 'e-1' })).rejects.toThrow(/uq_wt_provider_external/);
  });

  test('REFUND/ROLLBACK require a reference', async () => {
    const id = await wallet();
    await expect(wagerTx(id, { kind: 'REFUND' })).rejects.toThrow(/ck_wt_reference_required/);
    await expect(wagerTx(id, { kind: 'ROLLBACK' })).rejects.toThrow(/ck_wt_reference_required/);
  });

  test('a reference is reversed at most once', async () => {
    const id = await wallet();
    const bet = await wagerTx(id);
    await wagerTx(id, {
      kind: 'REFUND',
      reference_external_transaction_id: 'x',
      reference_transaction_id: bet,
    });
    await expect(
      wagerTx(id, {
        kind: 'ROLLBACK',
        reference_external_transaction_id: 'x',
        reference_transaction_id: bet,
      }),
    ).rejects.toThrow(/uq_wt_reversal_once/);
    // A rejected attempt does not count.
    await wagerTx(id, {
      kind: 'REFUND',
      reference_external_transaction_id: 'x',
      reference_transaction_id: bet,
      status: 'REJECTED',
      failure_code: 'REFERENCE_ALREADY_REVERSED',
    });
  });

  test('status consistency checks', async () => {
    const id = await wallet();
    await expect(wagerTx(id, { status: 'REJECTED' })).rejects.toThrow(/ck_wt_failure_code/);
    await expect(wagerTx(id, { status: 'PENDING' })).rejects.toThrow(/ck_wt_terminal_processed_at/);
    await expect(
      wagerTx(id, {
        status: 'PENDING_REFERENCE',
        processed_at: null,
        kind: 'REFUND',
        reference_external_transaction_id: 'x',
      }),
    ).rejects.toThrow(/ck_wt_pending_reference_schedule/);
    await expect(wagerTx(id, { kind: 'JACKPOT' })).rejects.toThrow(/check constraint/);
    await expect(wagerTx(id, { amount: '-1.00' })).rejects.toThrow(/check constraint/);
  });

  test('inbox dedup by (consumer, message id)', async () => {
    await sql`INSERT INTO inbox_messages VALUES ('c', 'm-1', ${'a'.repeat(64)}, ${now}, NULL)`;
    await expect(
      exec(sql`INSERT INTO inbox_messages VALUES ('c', 'm-1', ${'b'.repeat(64)}, ${now}, NULL)`),
    ).rejects.toThrow(/duplicate key/);
    await sql`INSERT INTO inbox_messages VALUES ('other', 'm-1', ${'a'.repeat(64)}, ${now}, NULL)`;
  });

  test('money columns are exact numeric(20,2)', async () => {
    const [col] = await sql`
      SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
       WHERE table_name = 'wallets' AND column_name = 'balance'`;
    expect(col).toEqual({ data_type: 'numeric', numeric_precision: 20, numeric_scale: 2 });
  });
});
