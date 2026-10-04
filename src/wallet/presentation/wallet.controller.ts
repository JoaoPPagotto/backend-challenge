import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Core } from '../../composition';
import { RequestContext } from '../../shared/infrastructure/observability/request-context';
import {
  LedgerQuerySchema,
  OpenWalletBodySchema,
  UuidParamSchema,
} from '../../shared/presentation/http/contracts';
import { parse } from '../../shared/presentation/http/validation';
import { CORE } from '../../tokens';

@Controller('wallets')
export class WalletController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Post()
  @HttpCode(201)
  async open(@Body() body: unknown) {
    const cmd = parse(OpenWalletBodySchema, body);
    const wallet = await this.core.openWallet.execute({
      playerId: cmd.playerId,
      initialBalance: cmd.initialBalance,
      correlationId: RequestContext.get().correlationId ?? 'n/a',
    });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return this.core.getWallet.execute(this.walletId(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const q = parse(LedgerQuerySchema, query, 'query');
    return this.core.listLedger.execute(this.walletId(walletId), q.cursor, q.limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    return this.core.reconcileWallet.execute(this.walletId(walletId));
  }

  private walletId(raw: string): string {
    const id = parse(UuidParamSchema, raw, 'walletId');
    RequestContext.set({ walletId: id });
    return id;
  }
}
