import pg from 'pg';

const { Pool } = pg;

/**
 * Shared PostgreSQL helpers. These live beside the idempotency runner because that
 * already takes a Pool — every service that owns a database needs the same three
 * things, and four hand-copied versions would drift.
 */
export interface PoolOptions {
  databaseUrl: string;
  max?: number;
  statementTimeoutMs?: number;
  /** Called when an IDLE pooled client errors. See the note in createPool. */
  onError?: (error: Error) => void;
}

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: options.max ?? 20,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    // A request that cannot get a connection should fail fast and let the client
    // retry, rather than piling up and turning a spike into a stall.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  /*
   * An idle pooled client can error without any query being in flight — Postgres
   * restarts, a failover, an admin terminating backends (57P01), a network blip.
   *
   * `Pool` emits that as an 'error' event, and an EventEmitter 'error' with no
   * listener is an UNCAUGHT EXCEPTION that takes the process down. So a database
   * restart would kill every service at once, turning a recoverable blip into a
   * full outage. The pool discards the broken client and carries on by itself; all
   * this listener has to do is exist.
   */
  pool.on('error', (error: Error) => {
    if (options.onError !== undefined) {
      options.onError(error);
      return;
    }
    process.stderr.write(`${JSON.stringify({ level: 'warn', msg: 'idle pg client error', err: error.message })}\n`);
  });

  return pool;
}

/** Postgres error codes this codebase reacts to by name rather than by number. */
export const PgError = {
  uniqueViolation: '23505',
  exclusionViolation: '23P01',
  foreignKeyViolation: '23503',
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
 * so a retry re-evaluates the condition against committed state.
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
