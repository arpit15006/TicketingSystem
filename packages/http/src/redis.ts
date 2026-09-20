// ioredis is CJS: the named export is the constructor under NodeNext resolution.
import { Redis, type RedisOptions } from 'ioredis';

export type { Redis };

export interface RedisClientOptions {
  url: string;
  keyPrefix?: string;
  onError?: (error: Error) => void;
}

/**
 * ADR-012 — Redis holds **no correctness state**. It backs the waiting-room queue,
 * the jti denylist, rate limiting and seatmap caching. It is never consulted to
 * decide whether a seat is available.
 *
 * The options below are what make "fail open" actually work:
 *
 *  - `enableOfflineQueue: false` — when Redis is down, commands REJECT immediately
 *    instead of queueing until it returns. A queued command looks like a slow
 *    request, and a slow request during an on-sale is indistinguishable from an
 *    outage to the user. Failing fast is what lets callers fall back.
 *  - `maxRetriesPerRequest: 1` — one retry, then give up and let the caller decide.
 *  - a bounded `retryStrategy` so reconnection keeps trying without a thundering herd.
 *
 * Without the first of these, every fail-open path in this codebase would instead
 * hang for the duration of the outage.
 */
export function createRedisClient(options: RedisClientOptions): Redis {
  const config: RedisOptions = {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 3_000),
    ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
  };

  const client = new Redis(options.url, config);

  // An unhandled 'error' on an EventEmitter terminates the process. Redis being
  // unreachable must degrade the waiting room, never take the service down.
  client.on('error', (error: Error) => {
    options.onError?.(error);
  });

  return client;
}

/**
 * Run a Redis operation, falling back if Redis cannot answer.
 *
 * This is the single mechanism behind INV-7 on the Redis side: every caller states
 * what "Redis is unavailable" should mean for it, and none of them can accidentally
 * turn an outage into an error the user sees. The fallback is always the permissive
 * choice — let the user through — because Redis holds nothing that protects a seat.
 */
export async function withRedisFallback<T>(
  operation: () => Promise<T>,
  fallback: T,
  onFailure?: (error: unknown) => void,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    onFailure?.(error);
    return fallback;
  }
}
