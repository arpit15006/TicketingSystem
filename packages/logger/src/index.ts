import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/**
 * PRD §14 — fields that must never reach a log sink.
 * Redaction is configured at the logger, not at call sites, because a call site
 * that forgets is a credential leak and there is no way to audit every one.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'key_secret',
  '*.key_secret',
  'razorpay_signature',
  '*.razorpay_signature',
  'refreshToken',
  '*.refreshToken',
] as const;

export interface CreateLoggerOptions {
  service: string;
  level?: string | undefined;
  pretty?: boolean | undefined;
}

/**
 * Named log events from PRD §14. Using the constant rather than a string literal keeps
 * the set greppable — the README's requestId trace depends on these names being stable.
 */
export const LogEvent = {
  seatHoldWon: 'seat.hold.won',
  seatHoldLost: 'seat.hold.lost',
  seatFinalizeFailed: 'seat.finalize.failed',
  paymentAfterExpiryCompensated: 'payment.after_expiry.compensated',
  webhookDuplicateIgnored: 'webhook.duplicate.ignored',
  refreshReuseDetected: 'refresh.reuse.detected',
  segmentExclusionViolated: 'segment.exclusion.violated',
  oversellDetected: 'oversell.detected',
} as const;

export type LogEventName = (typeof LogEvent)[keyof typeof LogEvent];

export function createLogger(options: CreateLoggerOptions): Logger {
  const pretty = options.pretty ?? process.env['NODE_ENV'] === 'development';

  const base: LoggerOptions = {
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    base: { service: options.service },
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  // pino-pretty is a dev-only dependency (PRD §3); production emits raw JSON.
  if (pretty) {
    return pino({ ...base, transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } });
  }
  return pino(base);
}

/** PRD §14 — bind requestId so every line of one booking shares an ID across services. */
export function withRequestId(logger: Logger, requestId: string): Logger {
  return logger.child({ requestId });
}
