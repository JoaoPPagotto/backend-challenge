import { DomainError, ValidationError } from '../errors/domain.error';
import { FailureCode } from '../errors/failure-code';

export class InvalidMoneyError extends ValidationError {}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(FailureCode.CurrencyMismatch, `Currency mismatch: expected ${expected}, got ${actual}`);
  }
}
