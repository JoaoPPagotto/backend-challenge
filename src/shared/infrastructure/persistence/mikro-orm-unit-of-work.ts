import {
  ConnectionException,
  DeadlockException,
  DriverException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../application/errors/application.errors';
import type { TransactionalRepositories, UnitOfWork } from '../../application/ports/unit-of-work.port';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './repositories';

function reposFor(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

/** SQLSTATEs that mean "retry the whole transaction". */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000',
  '08003',
  '08006',
  '08001',
  '08004', // connection exceptions
]);
const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export function toTransient(error: unknown): TransientInfrastructureError | undefined {
  if (error instanceof TransientInfrastructureError) return error;
  if (error instanceof DeadlockException)
    return new TransientInfrastructureError('Deadlock', 'deadlock', { cause: error });
  if (error instanceof LockWaitTimeoutException) {
    return new TransientInfrastructureError('Lock wait timeout', 'lock_timeout', { cause: error });
  }
  if (error instanceof ConnectionException) {
    return new TransientInfrastructureError('Database connection failure', 'db_connection', { cause: error });
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NODE_CODES.has(code))) {
    const reason = code === '55P03' ? 'lock_timeout' : code === '40P01' ? 'deadlock' : 'db_unavailable';
    return new TransientInfrastructureError(`Transient database error (${code})`, reason, { cause: error });
  }
  if (
    error instanceof Error &&
    /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(
      error.message,
    )
  ) {
    return new TransientInfrastructureError('Database connection failure', 'db_connection', { cause: error });
  }
  if (error instanceof DriverException && /terminating connection/i.test(error.message)) {
    return new TransientInfrastructureError('Database connection terminated', 'db_connection', {
      cause: error,
    });
  }
  return undefined;
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      // lock_timeout is a session default set when the pool creates the connection (see mikro-orm.config).
      return await this.orm.em.fork().transactional((em) => work(reposFor(em)));
    } catch (error) {
      throw toTransient(error) ?? error;
    }
  }

  async read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await work(reposFor(this.orm.em.fork()));
    } catch (error) {
      throw toTransient(error) ?? error;
    }
  }
}
