import { TransientInfrastructureError } from './errors/application.errors';

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  /** Which transient reasons are worth retrying in-process (others are surfaced immediately). */
  retryOn: readonly string[];
  onRetry?: (reason: string, attempt: number) => void;
}

/** Bounded retry with jittered exponential backoff, only for transient errors. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const retryable = error instanceof TransientInfrastructureError && opts.retryOn.includes(error.reason);
      if (!retryable || attempt >= opts.attempts) throw error;
      opts.onRetry?.(error.reason, attempt);
      const delay = opts.baseDelayMs * 2 ** (attempt - 1);
      await Bun.sleep(delay + Math.floor(Math.random() * delay));
    }
  }
}
