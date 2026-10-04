import { Migrator } from '@mikro-orm/migrations';
import { type Options, PostgreSqlDriver, defineConfig } from '@mikro-orm/postgresql';
import { Migration20260101000000_initial } from '../../../../migrations/Migration20260101000000_initial';
import { ENTITY_SCHEMAS } from './schemas';

export const MIGRATIONS = [
  { name: 'Migration20260101000000_initial', class: Migration20260101000000_initial },
];

export function buildOrmConfig(databaseUrl: string, poolMax = 20, lockTimeoutMs = 5000): Options {
  return defineConfig({
    driver: PostgreSqlDriver,
    clientUrl: databaseUrl,
    entities: ENTITY_SCHEMAS,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: {
      min: 0,
      max: poolMax,
      // Session defaults set once per physical connection (instead of a round trip per transaction):
      // a hot wallet surfaces as a retryable lock_timeout instead of an unbounded wait.
      afterCreate: (
        conn: { query: (sql: string, cb: (err: Error | null) => void) => void },
        done: (err: Error | null, conn: unknown) => void,
      ) => {
        conn.query(
          `SET lock_timeout = ${Math.trunc(lockTimeoutMs)}; SET idle_in_transaction_session_timeout = 60000`,
          (err) => done(err, conn),
        );
      },
    },
    debug: false,
    allowGlobalContext: false,
    forceUtcTimezone: true,
    // numeric(20,2) is mapped as string — money never touches JS numbers.
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      silent: process.env.NODE_ENV === 'test',
      // Schema is hand-written SQL; no entity-diff snapshots in the repo.
      snapshot: false,
      migrationsList: MIGRATIONS,
    },
  });
}
