import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Core } from '../composition';
import { APP_CONFIG, type AppConfig } from '../shared/infrastructure/config/app-config';
import type { QueueUrls } from '../shared/infrastructure/messaging/sqs-client';
import type { PromMetrics } from '../shared/infrastructure/observability/prom-metrics';
import { CORE, PROM_METRICS, QUEUE_URLS, SQS_CLIENT } from '../tokens';

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Open endpoints (no auth): liveness, readiness and Prometheus metrics. */
@Controller()
export class HealthController {
  constructor(
    @Inject(CORE) private readonly core: Core,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROM_METRICS) private readonly metrics: PromMetrics,
    @Inject(QUEUE_URLS) private readonly queues: QueueUrls,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok', instanceId: this.config.INSTANCE_ID };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const [postgres, sqs] = await Promise.all([
      withTimeout(this.core.orm.em.getConnection().execute('SELECT 1'), 2000).then(
        () => 'up' as const,
        () => 'down' as const,
      ),
      withTimeout(
        this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: this.queues.wager,
            AttributeNames: ['QueueArn'],
          }),
        ),
        2000,
      ).then(
        () => 'up' as const,
        () => 'down' as const,
      ),
    ]);
    const ok = postgres === 'up' && sqs === 'up';
    void reply.status(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'unavailable',
      instanceId: this.config.INSTANCE_ID,
      checks: { postgres, sqs },
    };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async prometheus() {
    return this.metrics.registry.metrics();
  }
}
