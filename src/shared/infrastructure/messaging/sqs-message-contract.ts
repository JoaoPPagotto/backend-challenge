import { z } from 'zod';
import { WagerTransactionBodySchema } from '../../presentation/http/contracts';

/** Queue message contract (section 10). Validated before anything else happens. */
export const WagerTransactionRequestedSchema = z.object({
  messageId: z.string().min(1).max(255),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime({ offset: true }),
  data: WagerTransactionBodySchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
});

export type WagerTransactionRequested = z.infer<typeof WagerTransactionRequestedSchema>;
