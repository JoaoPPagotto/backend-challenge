import { NotFoundError } from '../../shared/application/errors/application.errors';
import type { AppLogger, AppMetrics } from '../../shared/application/ports/observability.port';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.port';
import { Money, type MoneyProps } from '../../shared/domain/money/money';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger, under the
 * wallet row lock (consistent snapshot). Divergences are logged, counted and reported —
 * never silently corrected.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: AppLogger,
    private readonly metrics: AppMetrics,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(async (r) => {
      const wallet = await r.wallets.lockById(walletId);
      if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);
      const totals = await r.ledger.totals(walletId);
      const calculated = Money.from({ amount: totals.net, currency: wallet.currency });
      const difference = wallet.balance.subtract(calculated);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: totals.count,
      };
    });
    if (!report.consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('wallet reconciliation divergence detected', {
        walletId,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
