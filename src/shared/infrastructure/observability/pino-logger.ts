import pino, { type Logger } from 'pino';
import type { AppLogger, LogFields } from '../../application/ports/observability.port';
import { RequestContext } from './request-context';

/**
 * Keys that may carry monetary values or full payloads. They are removed from every log
 * line no matter who logs them: logs carry ids, kinds, statuses and codes — never money.
 */
const REDACT = [
  'money',
  'amount',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'initialBalance',
  'payload',
  'body',
  'data',
  '*.money',
  '*.amount',
  '*.balance',
  '*.payload',
  '*.body',
  'req.headers.authorization',
];

export function createPinoLogger(level: string, instanceId: string): Logger {
  return pino({
    level,
    base: { service: 'wagering-processor', instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT, remove: true },
    mixin: () => ({ ...RequestContext.get() }),
  });
}

export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: Logger) {}

  debug(msg: string, fields?: LogFields): void {
    this.logger.debug(fields ?? {}, msg);
  }
  info(msg: string, fields?: LogFields): void {
    this.logger.info(fields ?? {}, msg);
  }
  warn(msg: string, fields?: LogFields): void {
    this.logger.warn(fields ?? {}, msg);
  }
  error(msg: string, fields?: LogFields, err?: unknown): void {
    const rest = fields ?? {};
    const errFields =
      err instanceof Error
        ? { err: { type: err.name, message: err.message, stack: err.stack } }
        : err
          ? { err: String(err) }
          : {};
    this.logger.error({ ...rest, ...errFields }, msg);
  }
}
