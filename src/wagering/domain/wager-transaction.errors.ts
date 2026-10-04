import {
  DomainError,
  InvariantViolationError,
  ValidationError,
} from '../../shared/domain/errors/domain.error';
import { FailureCode } from '../../shared/domain/errors/failure-code';

export class InvalidTransactionStateError extends InvariantViolationError {}

export class MissingReferenceError extends ValidationError {
  override readonly code = FailureCode.ReferenceRequired;
}

export class KindNotAllowedError extends ValidationError {
  override readonly code = FailureCode.KindNotAllowed;
}

export class IdempotencyConflictError extends DomainError {
  constructor(
    public readonly idempotencyKey: string,
    public readonly existingTransactionId: string,
  ) {
    super(
      FailureCode.IdempotencyPayloadMismatch,
      `Idempotency key "${idempotencyKey}" reused with a different payload`,
    );
  }
}

export class TransactionNotFoundError extends Error {
  constructor(id: string) {
    super(`Transaction ${id} not found`);
    this.name = 'TransactionNotFoundError';
  }
}
