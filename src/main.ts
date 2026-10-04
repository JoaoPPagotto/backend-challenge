import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { loadConfig } from './shared/infrastructure/config/app-config';
import { createPinoLogger } from './shared/infrastructure/observability/pino-logger';

export async function bootstrap(): Promise<NestFastifyApplication> {
  const config = loadConfig();
  const pino = createPinoLogger(config.LOG_LEVEL, config.INSTANCE_ID);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config, pino),
    new FastifyAdapter({ bodyLimit: 64 * 1024, genReqId: () => Bun.randomUUIDv7() }),
    { logger: ['error', 'warn'], abortOnError: false },
  );
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  await app.listen(config.PORT, '0.0.0.0');
  pino.info({ port: config.PORT }, 'wagering processor listening');
  return app;
}

if (import.meta.main) {
  bootstrap().catch((error: unknown) => {
    console.error(JSON.stringify({ level: 'fatal', msg: 'failed to start', err: String(error) }));
    process.exit(1);
  });
}
