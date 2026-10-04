import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('true')
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  INSTANCE_ID: z.string().min(1).default(`instance-${process.pid}`),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(20),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().url().optional(),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  /** Queue URLs are optional: when absent they are resolved by name (GetQueueUrl) at startup. */
  SQS_WAGER_QUEUE_URL: z.string().url().optional(),
  SQS_WAGER_DLQ_URL: z.string().url().optional(),
  SQS_EVENTS_QUEUE_URL: z.string().url().optional(),
  SQS_WAGER_QUEUE_NAME: z.string().default('wager-transactions.fifo'),
  SQS_WAGER_DLQ_NAME: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: z.string().default('wagering-events.fifo'),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).default(5),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(30),
  SQS_CONSUMER_ENABLED: bool,
  SQS_CONSUMER_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(10),
  OUTBOX_ENABLED: bool,
  OUTBOX_POLL_MS: z.coerce.number().int().min(10).default(500),
  OUTBOX_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  PENDING_REF_ENABLED: bool,
  PENDING_REF_POLL_MS: z.coerce.number().int().min(10).default(5000),
  PENDING_REF_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  PENDING_REF_TTL_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(15 * 60_000),
  PENDING_REF_BASE_DELAY_MS: z.coerce.number().int().min(1).default(1000),
  PENDING_REF_MAX_DELAY_MS: z.coerce.number().int().min(1).default(60_000),
  WALLET_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(25_000),
  /** Test-only fault injection: exit right after commit, before acking the SQS message. */
  FAULT_CRASH_AFTER_COMMIT: bool.default('false'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  if (parsed.data.FAULT_CRASH_AFTER_COMMIT && parsed.data.NODE_ENV !== 'test') {
    throw new Error('FAULT_CRASH_AFTER_COMMIT is only allowed with NODE_ENV=test');
  }
  return parsed.data;
}
