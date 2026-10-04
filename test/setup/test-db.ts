import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { buildOrmConfig } from '../../src/shared/infrastructure/persistence/mikro-orm.config';

/**
 * Real PostgreSQL for integration tests. A template database is migrated once; every
 * test file gets its own database cloned from it (fast, fully isolated).
 * Override with TEST_DATABASE_ADMIN_URL (default matches `docker compose --profile test`).
 */
export const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/postgres';
const TEMPLATE = 'wagering_template';

function urlFor(db: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

let templateReady: Promise<void> | undefined;

async function ensureTemplate(): Promise<void> {
  const admin = new SQL(ADMIN_URL);
  try {
    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${TEMPLATE}`;
    if (exists.length > 0 && process.env.TEST_REBUILD_TEMPLATE !== '1') return;
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEMPLATE}`);
  } finally {
    await admin.close();
  }
  const orm = await MikroORM.init(buildOrmConfig(urlFor(TEMPLATE), 2));
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}

export interface TestDatabase {
  name: string;
  url: string;
  sql: SQL;
  drop(): Promise<void>;
}

export async function createTestDatabase(prefix = 't'): Promise<TestDatabase> {
  templateReady ??= ensureTemplate();
  await templateReady;
  const name = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new SQL(ADMIN_URL);
  try {
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
  } finally {
    await admin.close();
  }
  const url = urlFor(name);
  const sql = new SQL(url);
  return {
    name,
    url,
    sql,
    async drop() {
      await sql.close();
      const a = new SQL(ADMIN_URL);
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.close();
      }
    },
  };
}

/** Fresh, empty, un-migrated database (for migration up/down tests). */
export async function createEmptyDatabase(): Promise<TestDatabase> {
  const name = `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new SQL(ADMIN_URL);
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.close();
  }
  const url = urlFor(name);
  const sql = new SQL(url);
  return {
    name,
    url,
    sql,
    async drop() {
      await sql.close();
      const a = new SQL(ADMIN_URL);
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.close();
      }
    },
  };
}
