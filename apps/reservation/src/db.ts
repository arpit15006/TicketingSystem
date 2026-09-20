import pg from 'pg';
import type { Config } from './config.js';

const { Pool } = pg;
export type { Pool, PoolClient } from 'pg';

/** UUID[] round-trips as strings; never let pg coerce ids into anything clever. */
export function createPool(config: Config): pg.Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    statement_timeout: config.statementTimeoutMs,
    // A booking request that cannot get a connection should fail fast and let the
    // client retry, rather than piling up and turning a spike into a stall.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

/** Postgres error codes this codebase reacts to by name rather than by number. */
export const PgError = {
  uniqueViolation: '23505',
  exclusionViolation: '23P01',
  deadlockDetected: '40P01',
  serializationFailure: '40001',
} as const;

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the pool will discard it. Surfacing the
      // rollback failure would mask the original error, which is the useful one.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A basket updates several seat rows, and two baskets touching the same seats in a
 * different physical order can deadlock. Postgres detects that and kills one side,
 * so the honest fix is a bounded retry rather than pretending it cannot happen.
 * Correctness never depends on this — a deadlocked transaction rolled back entirely,
 * so a retry re-evaluates the allocation condition against committed state.
 */
export async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const code = pgErrorCode(error);
      if (code !== PgError.deadlockDetected && code !== PgError.serializationFailure) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
