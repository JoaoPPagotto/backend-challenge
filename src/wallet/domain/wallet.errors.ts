import {
  DomainError,
  InvariantViolationError,
  ValidationError,
} from '../../shared/domain/errors/domain.error';
import { FailureCode } from '../../shared/domain/errors/failure-code';

export class InsufficientBalanceError extends DomainError {
  constructor(walletId: string) {
    super(FailureCode.InsufficientBalance, `Insufficient balance in wallet ${walletId}`);
  }
}

/** A reversal (ROLLBACK) would push the balance below zero. Distinct from a BET without funds. */
export class ReversalWouldOverdrawError extends DomainError {
  constructor(walletId: string) {
    super(FailureCode.ReversalWouldOverdraw, `Reversal would overdraw wallet ${walletId}`);
  }
}

export class InvalidWalletOperationError extends ValidationError {}

export class UnbalancedLedgerEntryError extends InvariantViolationError {}

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player ${playerId} in ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super(FailureCode.WalletNotFound, `Wallet ${walletId} not found`);
  }
}
