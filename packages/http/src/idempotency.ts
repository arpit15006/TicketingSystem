import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ErrorCode } from '@ticketing/contracts';
import { AppError } from './errors.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export interface IdempotentOutcome<T> {
  statusCode: number;
  body: T;
}

interface StoredErrorBody {
  __error: true;
  code: string;
  message: string;
  details?: unknown;
}

/** Key order must not change the hash — a client re-serialising its own body is not a new request. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/**
 * ADR-009 — the hash covers the route as well as the body, so reusing a key across
 * two different endpoints is caught as loudly as reusing it with a different body.
 */
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method.toUpperCase()} ${path}\n${JSON.stringify(canonicalize(body))}`).digest('hex');
}

function isStoredError(body: unknown): body is StoredErrorBody {
  return typeof body === 'object' && body !== null && (body as StoredErrorBody).__error === true;
}

/**
 * ADR-009 — idempotent execution of a mutating request.
 *
 * The key is *claimed* with an INSERT before the handler runs, so two concurrent
 * requests carrying the same key can never both execute: the unique constraint on
 * `key` decides the winner, exactly as the seat allocation lets the database decide
 * (ADR-002). The loser sees a row whose response is not yet stored and is told to
 * retry rather than being served a half-finished result.
 *
 * Deliberate failures (AppError) are stored and replayed, because "these seats are
 * gone" is an answer and must stay the same answer. Unexpected failures release the
 * key: a crash must not permanently poison a key the client is entitled to retry.
 */
export async function runIdempotent<T>(
  pool: Pool,
  args: { key: string | null; userId: string; requestHash: string },
  handler: () => Promise<IdempotentOutcome<T>>,
): Promise<IdempotentOutcome<T>> {
  const { key, userId, requestHash } = args;
  if (key === null) return handler();

  const claim = await pool.query<{ key: string }>(
    `INSERT INTO idempotency_keys (key, user_id, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, userId, requestHash],
  );

  if (claim.rowCount === 1) {
    try {
      const outcome = await handler();
      await pool.query(
        `UPDATE idempotency_keys SET response_code = $2, response_body = $3 WHERE key = $1`,
        [key, outcome.statusCode, JSON.stringify(outcome.body)],
      );
      return outcome;
    } catch (error) {
      if (error instanceof AppError) {
        const stored: StoredErrorBody = {
          __error: true,
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        };
        await pool.query(
          `UPDATE idempotency_keys SET response_code = $2, response_body = $3 WHERE key = $1`,
          [key, error.statusCode, JSON.stringify(stored)],
        );
        throw error;
      }
      await pool.query(`DELETE FROM idempotency_keys WHERE key = $1 AND response_code IS NULL`, [key]);
      throw error;
    }
  }

  const existing = await pool.query<{
    user_id: string;
    request_hash: string;
    response_code: number | null;
    response_body: unknown;
  }>(`SELECT user_id, request_hash, response_code, response_body FROM idempotency_keys WHERE key = $1`, [key]);

  const row = existing.rows[0];
  if (row === undefined) {
    // The claim lost the INSERT race and the winner then released the key after an
    // unexpected failure. Treat it as retryable rather than inventing a result.
    throw new AppError(409, ErrorCode.idempotentRequestInProgress, 'Idempotent request is in progress; retry shortly', { key });
  }

  if (row.user_id !== userId || row.request_hash !== requestHash) {
    throw new AppError(422, ErrorCode.idempotencyKeyReused, 'Idempotency-Key was already used with a different request', { key });
  }

  if (row.response_code === null) {
    throw new AppError(409, ErrorCode.idempotentRequestInProgress, 'Idempotent request is in progress; retry shortly', { key });
  }

  if (isStoredError(row.response_body)) {
    const body = row.response_body;
    throw new AppError(row.response_code, body.code as never, body.message, body.details);
  }

  return { statusCode: row.response_code, body: row.response_body as T };
}
