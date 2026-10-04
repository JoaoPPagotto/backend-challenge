import { Core, type CoreConfig, type CoreDeps } from '../../src/composition';
import type { ProcessWagerTransactionCommand } from '../../src/wagering/application/process-wager-transaction.usecase';
import { type TestDatabase, createTestDatabase } from './test-db';

export interface CoreHarness {
  db: TestDatabase;
  core: Core;
  close(): Promise<void>;
}

export async function createCore(
  overrides: Partial<CoreConfig> = {},
  deps: CoreDeps = {},
): Promise<CoreHarness> {
  const db = await createTestDatabase('core');
  const core = await Core.create(
    {
      DATABASE_URL: db.url,
      DB_POOL_MAX: 20,
      WALLET_LOCK_TIMEOUT_MS: 5000,
      PENDING_REF_MAX_ATTEMPTS: 3,
      PENDING_REF_TTL_MS: 60_000,
      PENDING_REF_BASE_DELAY_MS: 1,
      PENDING_REF_MAX_DELAY_MS: 5,
      ...overrides,
    },
    deps,
  );
  return {
    db,
    core,
    async close() {
      await core.close();
      await db.drop();
    },
  };
}

let seq = 0;
export function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 6)}`;
}

export type TxInput = Omit<ProcessWagerTransactionCommand, 'context' | 'idempotencyKey'> & {
  idempotencyKey?: string;
};

export function command(input: TxInput, channel: 'http' | 'sqs' = 'http'): ProcessWagerTransactionCommand {
  return {
    ...input,
    idempotencyKey: input.idempotencyKey ?? `${input.providerId}:${input.externalTransactionId}`,
    context: { channel, correlationId: uniq('corr') },
  };
}

export const brl = (amount: string) => ({ amount, currency: 'BRL' });
