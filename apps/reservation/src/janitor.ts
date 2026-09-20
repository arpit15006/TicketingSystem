import type { Pool } from 'pg';
import { JANITOR_SQL } from './allocation.js';

/**
 * PRD §8.2 / ADR-003 — the janitor.
 *
 * It exists so that a naive `SELECT * FROM seats` and any analytics query read
 * cleanly. It is NOT on the correctness path: every allocation query already treats
 * `held_until < now()` as available, so a seat this job has not yet tidied is still
 * sellable. If this never runs, nothing oversells and nothing is stranded.
 *
 * Tests run with it disabled, deliberately — an expiry test that needed the janitor
 * would be testing the wrong mechanism.
 */
/** Structurally typed so both a pino Logger and Fastify's logger satisfy it. */
export interface JanitorLogger {
  debug: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export function startJanitor(pool: Pool, logger: JanitorLogger, intervalMs: number): () => void {
  const timer = setInterval(() => {
    pool
      .query(JANITOR_SQL)
      .then((result) => {
        if (result.rowCount !== null && result.rowCount > 0) {
          logger.debug({ tidiedSeats: result.rowCount }, 'janitor tidied stale holds');
        }
      })
      .catch((error: unknown) => {
        // A failed janitor run is a cosmetic problem, never a correctness one.
        logger.warn({ err: error }, 'janitor pass failed (cosmetic, safe to ignore)');
      });
  }, intervalMs);

  timer.unref();
  return () => clearInterval(timer);
}
