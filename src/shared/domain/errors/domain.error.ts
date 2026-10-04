import { FailureCode } from './failure-code';

/** Business-rule violation. Carries a stable FailureCode. */
export class DomainError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid input contract (maps to 400). */
export class ValidationError extends DomainError {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(FailureCode.InvalidPayload, message);
  }
}

/**
 * Programming error: something that must never happen if the code is correct
 * (e.g. transitioning a terminal transaction). Never mapped to a 4xx.
 */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
