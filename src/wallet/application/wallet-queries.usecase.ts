import { NotFoundError } from '../../shared/application/errors/application.errors';
import type { UnitOfWork } from '../../shared/application/ports/unit-of-work.port';
import { ValidationError } from '../../shared/domain/errors/domain.error';
import { type LedgerEntryView, type WalletView, toLedgerEntryView, toWalletView } from './wallet.dto';

export class GetWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.read((r) => r.wallets.findById(walletId));
    if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);
    return toWalletView(wallet);
  }
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque, stable cursor: base64url of the last entry id (uuid v7 → time ordered, unique). */
export function encodeCursor(id: string): string {
  return Buffer.from(`l:${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const id = raw.startsWith('l:') ? raw.slice(2) : '';
  if (!UUID.test(id)) throw new ValidationError('Invalid cursor');
  return id;
}

export class ListLedgerUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const afterId = cursor ? decodeCursor(cursor) : undefined;
    return this.uow.read(async (r) => {
      const wallet = await r.wallets.findById(walletId);
      if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);
      const rows = await r.ledger.page(walletId, afterId, limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map(toLedgerEntryView),
        nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null,
      };
    });
  }
}
