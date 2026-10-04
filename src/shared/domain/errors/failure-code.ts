/**
 * Stable, machine-readable failure codes. The provider uses them (together with
 * the HTTP status) to decide whether to resend, fix the payload or give up.
 * See ARCHITECTURE.md § Failure codes.
 */
export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceRequired = 'REFERENCE_REQUIRED',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  KindNotAllowed = 'KIND_NOT_ALLOWED',
  IdempotencyPayloadMismatch = 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  InvalidPayload = 'INVALID_PAYLOAD',
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}

export const FAILURE_CODES: readonly string[] = Object.values(FailureCode);

export function isFailureCode(value: string): value is FailureCode {
  return FAILURE_CODES.includes(value);
}
