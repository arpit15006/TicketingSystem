import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inject } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase, startTestIdentity, type TestDatabase, type TestIdentity } from '@ticketing/testkit';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { buildServer, type ReservationServer } from '../src/server.js';
import { resetCounters } from '../src/metrics.js';

export const TEST_SERVICE_TOKEN = 'test-internal-service-token';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface Harness {
  app: ReservationServer;
  pool: Pool;
  db: TestDatabase;
  baseUrl: string;
  /** Real RS256 signer + JWKS endpoint; the service verifies against it for real. */
  identity: TestIdentity;
  /** Authorization header for an attendee — what a booking request needs. */
  auth: (userId?: string) => Promise<Record<string, string>>;
  /** Header proving a caller is another service — required by internal routes. */
  serviceHeaders: Record<string, string>;
  stop: () => Promise<void>;
}

/**
 * Boots the real service against a real PostgreSQL database on a real TCP port.
 * Nothing here is injected, faked or stubbed: the tests talk to the service exactly
 * the way a client does, which is the only way the concurrency proof means anything.
 */
export async function startHarness(options: { holdDurationSeconds?: number } = {}): Promise<Harness> {
  const adminUrl = inject('pgAdminUrl');
  const db = await createTestDatabase({ adminUrl, migrationsDir: MIGRATIONS_DIR });
  const identity = await startTestIdentity();

  const config = loadConfig({
    databaseUrl: db.url,
    nodeEnv: 'test',
    logLevel: 'silent',
    holdDurationSeconds: options.holdDurationSeconds ?? 480,
    // ADR-010 — the service verifies tokens itself against a real JWKS endpoint.
    jwksUri: identity.jwksUri,
    jwtIssuer: identity.issuer,
    jwtAudience: identity.audience,
    internalServiceToken: TEST_SERVICE_TOKEN,
    // Enough connections that the pool is not the bottleneck the test accidentally
    // measures; Postgres is configured for 300 backends.
    pgPoolMax: 60,
    // ADR-003 — the janitor is OFF in every test. An expiry test that needed a
    // background job to run would be testing the wrong mechanism entirely.
    janitorEnabled: false,
  });

  const pool = createPool({ databaseUrl: config.databaseUrl, max: config.pgPoolMax, statementTimeoutMs: config.statementTimeoutMs });
  const app = await buildServer({ config, pool });
  resetCounters();

  await app.listen({ port: 0, host: '127.0.0.1', backlog: 4096 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a TCP port');

  return {
    app,
    pool,
    db,
    baseUrl: `http://127.0.0.1:${address.port}`,
    identity,
    auth: identity.attendee,
    serviceHeaders: { 'x-internal-token': TEST_SERVICE_TOKEN },
    stop: async () => {
      // Order matters: DROP DATABASE ... WITH FORCE terminates any surviving backend,
      // which surfaces as an uncaught 57P01 on whatever connection was still open.
      // The service pool is separate from the test pool, so it must be closed too.
      await app.close();
      await pool.end();
      await db.drop();
      await identity.stop();
    },
  };
}

export interface SeededEvent {
  eventId: string;
  tierId: string;
  seatIds: string[];
}

/** Insert `count` available seats for a fresh event. */
export async function seedSeats(pool: Pool, count: number): Promise<SeededEvent> {
  const eventId = randomUUID();
  const tierId = randomUUID();

  const result = await pool.query<{ seat_id: string }>(
    `INSERT INTO seats (event_id, section, row_label, seat_number, tier_id)
     SELECT $1, 'A', 'R1', g::text, $2 FROM generate_series(1, $3) AS g
     RETURNING seat_id`,
    [eventId, tierId, count],
  );

  // Ordered so tests can address "seat i" deterministically across runs.
  return { eventId, tierId, seatIds: result.rows.map((r) => r.seat_id).sort() };
}

/** Force a hold past its expiry without sleeping (PRD §19 forbids sleep() in tests). */
export async function expireHold(pool: Pool, holdId: string): Promise<void> {
  await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE hold_id = $1`, [holdId]);
  await pool.query(`UPDATE seats SET held_until = now() - interval '1 second' WHERE hold_id = $1`, [holdId]);
}
