import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';
import { APP_LOGGER, type AppLogger } from '../../application/ports/observability.port';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config/app-config';
import { RequestContext } from '../../infrastructure/observability/request-context';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Opens the log context for the request: X-Correlation-Id in/out, plus a request id. */
@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  constructor(
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const header = req.headers['x-correlation-id'];
    const incoming = Array.isArray(header) ? header[0] : header;
    const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : Bun.randomUUIDv7();
    const requestId = String(req.id);
    void reply.header('X-Correlation-Id', correlationId);
    void reply.header('X-Instance-Id', this.config.INSTANCE_ID);
    const started = performance.now();

    return new Observable((subscriber) =>
      RequestContext.run({ correlationId, requestId }, () => {
        const sub = next.handle().subscribe({
          next: (v) => subscriber.next(v),
          error: (e) => {
            this.logRequest(req, reply, started, true);
            subscriber.error(e);
          },
          complete: () => {
            this.logRequest(req, reply, started, false);
            subscriber.complete();
          },
        });
        return () => sub.unsubscribe();
      }),
    );
  }

  private logRequest(req: FastifyRequest, reply: FastifyReply, started: number, failed: boolean): void {
    this.logger.info('http request', {
      method: req.method,
      route: req.routeOptions?.url ?? req.url,
      statusCode: failed ? undefined : reply.statusCode,
      failed,
      durationMs: Math.round(performance.now() - started),
    });
  }
}
