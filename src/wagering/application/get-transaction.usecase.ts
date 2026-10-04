import { NotFoundError } from '../../shared/application/errors/application.errors';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.port';
import type { MoneyProps } from '../../shared/domain/money/money';
import type { WagerTransaction } from '../domain/wager-transaction';

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balance: MoneyProps | null;
  referenceAttempts: number;
  createdAt: string;
  processedAt: string | null;
}

export function toTransactionView(t: WagerTransaction): WagerTransactionView {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    status: t.status,
    failureCode: t.failureCode ?? null,
    balance: t.observedBalance?.toJSON() ?? null,
    referenceAttempts: t.referenceAttempts,
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString() ?? null,
  };
}

export class GetTransactionUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(id: string): Promise<WagerTransactionView> {
    const tx = await this.uow.read((r) => r.transactions.findById(id));
    if (!tx) throw new NotFoundError(`Transaction ${id} not found`);
    return toTransactionView(tx);
  }

  async byProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const tx = await this.uow.read((r) =>
      r.transactions.findByProviderExternal(providerId, externalTransactionId),
    );
    if (!tx) throw new NotFoundError(`Transaction ${providerId}/${externalTransactionId} not found`);
    return toTransactionView(tx);
  }
}
