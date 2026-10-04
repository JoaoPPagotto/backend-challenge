/**
 * Infrastructure failure that is expected to go away (connection loss, lock timeout,
 * deadlock, optimistic version conflict). Safe to retry — nothing was committed.
 */
export class TransientInfrastructureError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}

/** The wallet row changed between read and conditional update (optimistic guard). */
export class WalletConcurrencyError extends TransientInfrastructureError {
  constructor(walletId: string) {
    super(`Concurrent modification of wallet ${walletId}`, 'wallet_version_conflict');
    this.name = 'WalletConcurrencyError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
