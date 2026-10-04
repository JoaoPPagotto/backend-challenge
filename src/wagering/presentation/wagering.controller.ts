import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Core } from '../../composition';
import { ValidationError } from '../../shared/domain/errors/domain.error';
import { RequestContext } from '../../shared/infrastructure/observability/request-context';
import {
  PROVIDER_IDENTITY,
  type ProviderIdentityPort,
} from '../../shared/presentation/auth/provider-identity.port';
import {
  IdempotencyKeySchema,
  UuidParamSchema,
  WagerTransactionBodySchema,
} from '../../shared/presentation/http/contracts';
import { parse } from '../../shared/presentation/http/validation';
import { CORE } from '../../tokens';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';

/** Success-path status codes; errors are mapped by DomainExceptionFilter. */
const STATUS_CODE: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller()
export class WageringController {
  constructor(
    @Inject(CORE) private readonly core: Core,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (idempotencyKey === undefined) {
      throw new ValidationError('Idempotency-Key header is required', [
        { path: 'Idempotency-Key', message: 'required' },
      ]);
    }
    const key = parse(IdempotencyKeySchema, idempotencyKey, 'Idempotency-Key header');
    const input = parse(WagerTransactionBodySchema, body);
    const provider = this.identity.resolve(req, input.providerId);
    RequestContext.set({ walletId: input.walletId, providerId: provider.providerId });

    const result = await this.core.processWagerTransaction.execute({
      ...input,
      providerId: provider.providerId,
      idempotencyKey: key,
      context: {
        channel: 'http',
        correlationId: RequestContext.get().correlationId ?? key,
        causationId: RequestContext.get().requestId,
      },
    });
    RequestContext.set({ transactionId: result.transactionId });
    void reply.status(STATUS_CODE[result.status]);
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    return this.core.getTransaction.byId(parse(UuidParamSchema, transactionId, 'transactionId'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProviderExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.core.getTransaction.byProviderExternal(providerId, externalTransactionId);
  }
}
