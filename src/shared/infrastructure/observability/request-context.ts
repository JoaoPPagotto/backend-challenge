import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation fields propagated to every log line of a request / message. */
export interface RequestContextFields {
  correlationId?: string;
  requestId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContextFields>();

export const RequestContext = {
  run<T>(fields: RequestContextFields, fn: () => T): T {
    return storage.run({ ...fields }, fn);
  },
  get(): RequestContextFields {
    return storage.getStore() ?? {};
  },
  /** Enrich the current context (e.g. once the walletId is known). */
  set(fields: RequestContextFields): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },
};
