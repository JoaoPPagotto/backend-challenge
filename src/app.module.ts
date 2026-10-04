import type { SQSClient } from '@aws-sdk/client-sqs';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { Logger } from 'pino';
import { BackgroundWorkers } from './background-workers.service';
import { Core } from './composition';
import { HealthController } from './health/health.controller';
import { APP_LOGGER, APP_METRICS } from './shared/application/ports/observability.port';
import { APP_CONFIG, type AppConfig } from './shared/infrastructure/config/app-config';
import { createSqsClient, resolveQueueUrls } from './shared/infrastructure/messaging/sqs-client';
import { PinoAppLogger } from './shared/infrastructure/observability/pino-logger';
import { PromMetrics } from './shared/infrastructure/observability/prom-metrics';
import { NoopAuthGuard } from './shared/presentation/auth/noop-auth.guard';
import {
  PROVIDER_IDENTITY,
  UnverifiedProviderIdentityAdapter,
} from './shared/presentation/auth/provider-identity.port';
import { CorrelationInterceptor } from './shared/presentation/http/correlation.interceptor';
import { DomainExceptionFilter } from './shared/presentation/http/domain-exception.filter';
import { CORE, PROM_METRICS, QUEUE_URLS, SQS_CLIENT } from './tokens';
import { WageringController } from './wagering/presentation/wagering.controller';
import { WalletController } from './wallet/presentation/wallet.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, pino: Logger): DynamicModule {
    const logger = new PinoAppLogger(pino);
    const metrics = new PromMetrics();
    return {
      module: AppModule,
      controllers: [WalletController, WageringController, HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_LOGGER, useValue: logger },
        { provide: APP_METRICS, useValue: metrics },
        { provide: PROM_METRICS, useValue: metrics },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
        {
          provide: QUEUE_URLS,
          useFactory: (client: SQSClient) => resolveQueueUrls(client, config),
          inject: [SQS_CLIENT],
        },
        {
          provide: CORE,
          useFactory: () => Core.create(config, { logger, metrics }),
        },
        { provide: PROVIDER_IDENTITY, useClass: UnverifiedProviderIdentityAdapter },
        { provide: APP_GUARD, useClass: NoopAuthGuard },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor },
        BackgroundWorkers,
      ],
    };
  }
}
