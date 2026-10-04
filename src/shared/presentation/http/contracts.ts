import { z } from 'zod';

const CURRENCY = /^[A-Z]{3}$/;
/** Non-negative decimal string, scale ≤ 2, no exponent/sign/spaces. Never a JSON number. */
const AMOUNT = /^\d{1,18}(\.\d{1,2})?$/;

export const NonNegativeMoneySchema = z
  .object({
    amount: z.string().regex(AMOUNT, 'amount must be a non-negative decimal string with up to 2 decimals'),
    currency: z.string().regex(CURRENCY, 'currency must be ISO-4217 (3 uppercase letters)'),
  })
  .strict();

export const PositiveMoneySchema = NonNegativeMoneySchema.refine((m) => /[1-9]/.test(m.amount), {
  message: 'amount must be greater than zero',
  path: ['amount'],
});

const id = z.string().trim().min(1).max(255);

export const OpenWalletBodySchema = z
  .object({
    playerId: z.string().uuid(),
    initialBalance: NonNegativeMoneySchema,
  })
  .strict();

export const WagerTransactionBodySchema = z
  .object({
    providerId: id,
    externalTransactionId: id,
    playerId: z.string().uuid(),
    walletId: z.string().uuid(),
    roundId: id,
    gameId: id,
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'], {
      errorMap: () => ({
        message: 'kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK (OPENING is internal)',
      }),
    }),
    money: PositiveMoneySchema,
    referenceExternalTransactionId: id.optional(),
  })
  .strict();

export type WagerTransactionBody = z.infer<typeof WagerTransactionBodySchema>;

export const IdempotencyKeySchema = z.string().trim().min(1).max(512);

export const UuidParamSchema = z.string().uuid();

export const LedgerQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
