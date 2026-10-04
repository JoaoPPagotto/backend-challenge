import type { ZodType, ZodTypeDef } from 'zod';
import { ValidationError } from '../../domain/errors/domain.error';

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown, what = 'payload'): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      `Invalid ${what}`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
