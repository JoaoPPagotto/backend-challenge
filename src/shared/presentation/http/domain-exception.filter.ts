import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyConflictError } from '../../../wagering/domain/wager-transaction.errors';
import { WalletAlreadyExistsError } from '../../../wallet/domain/wallet.errors';
import { NotFoundError, TransientInfrastructureError } from '../../application/errors/application.errors';
import { APP_LOGGER, type AppLogger } from '../../application/ports/observability.port';
import { DomainError, ValidationError } from '../../domain/errors/domain.error';
import { FailureCode } from '../../domain/errors/failure-code';
import { RequestContext } from '../../infrastructure/observability/request-context';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The async context may already be gone when the filter runs, and errors raised before the
 * interceptor (e.g. malformed JSON) never had one: fall back to the response header, then
 * to the request header, then to a fresh id — and make sure the client gets it back.
 */
function resolveCorrelationId(reply: FastifyReply, request: FastifyRequest): string {
  const fromContext = RequestContext.get().correlationId;
  const fromReply = reply.getHeader('x-correlation-id');
  const fromRequest = request.headers['x-correlation-id'];
  const candidate =
    fromContext ??
    (typeof fromReply === 'string' ? fromReply : undefined) ??
    (typeof fromRequest === 'string' && SAFE_ID.test(fromRequest) ? fromRequest : undefined) ??
    Bun.randomUUIDv7();
  void reply.header('X-Correlation-Id', candidate);
  return candidate;
}

/**
 * One mapping for every endpoint, so a provider can decide by status code alone:
 *  400 invalid payload          → fix and resend
 *  404 not found
 *  409 idempotency conflict     → never resend with this key
 *  422 business rejection       → do not resend (transaction persisted, failureCode in body)
 *  202 accepted, pending        → (success path, not here)
 *  503 transient infrastructure → safe to retry the same request (Retry-After)
 *  500 programming error
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const correlationId = resolveCorrelationId(reply, request);
    const send = (status: number, body: Record<string, unknown>) => {
      void reply.status(status).send({ ...body, correlationId });
    };

    if (exception instanceof ValidationError) {
      send(400, {
        error: 'INVALID_PAYLOAD',
        failureCode: exception.code,
        message: exception.message,
        details: exception.details ?? null,
      });
      return;
    }
    if (exception instanceof IdempotencyConflictError) {
      send(409, {
        error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        failureCode: FailureCode.IdempotencyPayloadMismatch,
        transactionId: exception.existingTransactionId,
        message: exception.message,
      });
      return;
    }
    if (exception instanceof WalletAlreadyExistsError) {
      send(409, { error: 'WALLET_ALREADY_EXISTS', message: exception.message });
      return;
    }
    if (exception instanceof NotFoundError) {
      send(404, { error: 'NOT_FOUND', message: exception.message });
      return;
    }
    if (exception instanceof DomainError) {
      send(422, {
        error: 'BUSINESS_RULE_VIOLATION',
        failureCode: exception.code,
        message: exception.message,
      });
      return;
    }
    if (exception instanceof TransientInfrastructureError) {
      this.logger.warn('transient failure surfaced to client', { reason: exception.reason });
      void reply.header('Retry-After', '1');
      send(503, { error: 'TRANSIENT_FAILURE', retryable: true, reason: exception.reason });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 404) {
        send(404, { error: 'NOT_FOUND', message: 'Route not found' });
        return;
      }
      if (status < 500) {
        send(status, {
          error: status === 400 ? 'INVALID_PAYLOAD' : 'HTTP_ERROR',
          failureCode: FailureCode.InvalidPayload,
          message: exception.message,
        });
        return;
      }
    }
    const fastifyStatus = (exception as { statusCode?: unknown } | null)?.statusCode;
    if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
      send(400, {
        error: 'INVALID_PAYLOAD',
        failureCode: FailureCode.InvalidPayload,
        message: (exception as Error).message,
      });
      return;
    }
    this.logger.error('unhandled error', {}, exception);
    send(500, { error: 'INTERNAL_ERROR' });
  }
}
