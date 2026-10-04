import { MikroORM } from '@mikro-orm/postgresql';
import { type Clock, SystemClock } from './shared/application/ports/clock.port';
import { type IdGenerator, UuidV7Generator } from './shared/application/ports/id-generator.port';
import {
  type AppLogger,
  type AppMetrics,
  NoopLogger,
  NoopMetrics,
} from './shared/application/ports/observability.port';
import type { UnitOfWork } from './shared/application/ports/unit-of-work.port';
import type { AppConfig } from './shared/infrastructure/config/app-config';
import { MikroOrmUnitOfWork } from './shared/infrastructure/persistence/mikro-orm-unit-of-work';
import { buildOrmConfig } from './shared/infrastructure/persistence/mikro-orm.config';
import { GetTransactionUseCase } from './wagering/application/get-transaction.usecase';
import { ProcessWagerTransactionUseCase } from './wagering/application/process-wager-transaction.usecase';
import { RetryPendingReferencesUseCase } from './wagering/application/retry-pending-references.usecase';
import { WagerProcessor } from './wagering/application/wager-processor';
import { OpenWalletUseCase } from './wallet/application/open-wallet.usecase';
import { ReconcileWalletUseCase } from './wallet/application/reconcile-wallet.usecase';
import { GetWalletUseCase, ListLedgerUseCase } from './wallet/application/wallet-queries.usecase';

export type CoreConfig = Pick<
  AppConfig,
  | 'DATABASE_URL'
  | 'DB_POOL_MAX'
  | 'WALLET_LOCK_TIMEOUT_MS'
  | 'PENDING_REF_MAX_ATTEMPTS'
  | 'PENDING_REF_TTL_MS'
  | 'PENDING_REF_BASE_DELAY_MS'
  | 'PENDING_REF_MAX_DELAY_MS'
>;

export interface CoreDeps {
  logger?: AppLogger;
  metrics?: AppMetrics;
  clock?: Clock;
  ids?: IdGenerator;
}

/** Framework-agnostic composition root: wires ORM, unit of work and use cases. */
export class Core {
  readonly uow: UnitOfWork;
  readonly processor: WagerProcessor;
  readonly processWagerTransaction: ProcessWagerTransactionUseCase;
  readonly retryPendingReferences: RetryPendingReferencesUseCase;
  readonly openWallet: OpenWalletUseCase;
  readonly getWallet: GetWalletUseCase;
  readonly listLedger: ListLedgerUseCase;
  readonly reconcileWallet: ReconcileWalletUseCase;
  readonly getTransaction: GetTransactionUseCase;
  readonly logger: AppLogger;
  readonly metrics: AppMetrics;
  readonly clock: Clock;
  readonly ids: IdGenerator;

  private constructor(
    readonly orm: MikroORM,
    config: CoreConfig,
    deps: CoreDeps,
  ) {
    this.logger = deps.logger ?? new NoopLogger();
    this.metrics = deps.metrics ?? new NoopMetrics();
    this.clock = deps.clock ?? new SystemClock();
    this.ids = deps.ids ?? new UuidV7Generator();
    this.uow = new MikroOrmUnitOfWork(orm);
    this.processor = new WagerProcessor(this.ids, this.clock);
    this.processWagerTransaction = new ProcessWagerTransactionUseCase(
      this.uow,
      this.processor,
      this.ids,
      this.clock,
      this.logger,
      this.metrics,
      { baseDelayMs: config.PENDING_REF_BASE_DELAY_MS },
    );
    this.retryPendingReferences = new RetryPendingReferencesUseCase(
      this.uow,
      this.processor,
      this.clock,
      this.logger,
      this.metrics,
      {
        maxAttempts: config.PENDING_REF_MAX_ATTEMPTS,
        ttlMs: config.PENDING_REF_TTL_MS,
        baseDelayMs: config.PENDING_REF_BASE_DELAY_MS,
        maxDelayMs: config.PENDING_REF_MAX_DELAY_MS,
        batchSize: 100,
      },
    );
    this.openWallet = new OpenWalletUseCase(this.uow, this.ids, this.clock, this.logger);
    this.getWallet = new GetWalletUseCase(this.uow);
    this.listLedger = new ListLedgerUseCase(this.uow);
    this.reconcileWallet = new ReconcileWalletUseCase(this.uow, this.logger, this.metrics);
    this.getTransaction = new GetTransactionUseCase(this.uow);
  }

  static async create(config: CoreConfig, deps: CoreDeps = {}): Promise<Core> {
    const orm = await MikroORM.init(
      buildOrmConfig(config.DATABASE_URL, config.DB_POOL_MAX, config.WALLET_LOCK_TIMEOUT_MS),
    );
    return new Core(orm, config, deps);
  }

  async close(): Promise<void> {
    await this.orm.close(true);
  }
}
