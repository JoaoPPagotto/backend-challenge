import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../shared/domain/money/money';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Deterministic JSON: object keys sorted recursively, no whitespace, `undefined` fields omitted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): Json {
  if (value === null || typeof value !== 'object') {
    return value as Json;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const out: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortKeys(v);
  }
  return out;
}

/** Business fields that define "the same request". Transport metadata (headers, messageId) is excluded. */
export interface HashableWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * payloadHash = lowercase hex SHA-256 of the canonical JSON of the business subset.
 * Money is normalized first, so "25.0" and "25.00" hash the same.
 */
export function wagerPayloadHash(payload: HashableWagerPayload): string {
  const subset = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: Money.from(payload.money).toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId || undefined,
  };
  return sha256Hex(canonicalJson(subset));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
