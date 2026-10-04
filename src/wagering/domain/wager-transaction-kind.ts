export enum WagerTransactionKind {
  /** Internal: opening credit of a wallet. Never accepted from the API or the queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export const EXTERNAL_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export type ExternalWagerTransactionKind = (typeof EXTERNAL_KINDS)[number];
/** Wire representation ("BET", "WIN", …). */
export type ExternalKindValue = `${ExternalWagerTransactionKind}`;

export function parseExternalKind(value: string): ExternalWagerTransactionKind | undefined {
  return EXTERNAL_KINDS.find((k) => k === value);
}

/** Which kinds a given kind may reference. Empty = may not reference anything. */
export const ALLOWED_REFERENCE_KINDS: Readonly<
  Record<WagerTransactionKind, readonly WagerTransactionKind[]>
> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};
