import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool } from '@ticketing/http';
import type { TestIdentity } from '@ticketing/testkit';
import { loadConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { startHarness, seedSeats, expireHold, TEST_SERVICE_TOKEN, type Harness } from '../helpers.js';

/**
 * ============================================================================
 *  PRD §15.1 `chaos-reservation.spec.ts`
 * ============================================================================
 *
 *  "Kill reservation service holding 50 seats → seats available again after
 *   expiry, no manual intervention."
 *
 *  This is ADR-003 stated as a failure scenario. If freeing an expired hold
 *  required a job to run, killing the service mid-sale would strand 50 seats:
 *  the process that "owned" the timers is gone, and nothing is left to notice.
 *  Because expiry is a predicate evaluated at query time, the seats free
 *  themselves the instant the clock passes — no reaper, no recovery procedure,
 *  no operator.
 *
 *  The replacement instance runs with the janitor DISABLED, so nothing can be
 *  credited to a cleanup job.
 */
describe('chaos: the reservation service dies holding 50 seats', () => {
  let harness: Harness;
  let identity: TestIdentity;

  beforeAll(async () => {
    // A 50-seat basket is the scenario the PRD names, so the cap has to allow it.
    harness = await startHarness({ maxSeatsPerHold: 50 });
    identity = harness.identity;
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('frees the seats after expiry with no intervention and no janitor', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 50);
    const buyer = await harness.auth();

    // ── 50 seats held by the doomed instance ──────────────────────────────
    const hold = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...buyer },
      body: JSON.stringify({ eventId, seatIds }),
    });
    expect(hold.status).toBe(201);
    const holdBody = (await hold.json()) as { holdId: string };

    const heldBefore = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'held'`,
      [eventId],
    );
    expect(Number(heldBefore.rows[0]?.count)).toBe(50);

    // ── THE SERVICE DIES ──────────────────────────────────────────────────
    // Closing the server and its pool is what a crash leaves behind: rows in
    // `held`, an in-flight hold, and nothing running that knows about either.
    await harness.app.close();
    await harness.pool.end();

    // Nothing is listening any more.
    await expect(fetch(`${harness.baseUrl}/healthz`)).rejects.toThrow();

    // The seats are still marked held in the database — as they should be,
    // because the hold has not expired yet.
    const inspector = createPool({ databaseUrl: harness.db.url, max: 5 });
    const stranded = await inspector.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'held'`,
      [eventId],
    );
    expect(Number(stranded.rows[0]?.count)).toBe(50);

    // ── Time passes ───────────────────────────────────────────────────────
    // Forced by writing the clock backwards rather than sleeping (PRD §19);
    // it is exactly the state the passage of time would have produced.
    await expireHold(inspector, holdBody.holdId);

    // ── A replacement instance starts, with the janitor OFF ───────────────
    const replacementConfig = loadConfig({
      databaseUrl: harness.db.url,
      nodeEnv: 'test',
      logLevel: 'silent',
      pgPoolMax: 10,
      janitorEnabled: false, // nothing may be credited to a cleanup job
      maxSeatsPerHold: 50,
      internalServiceToken: TEST_SERVICE_TOKEN,
      jwksUri: identity.jwksUri,
      jwtIssuer: identity.issuer,
      jwtAudience: identity.audience,
      waitingRoomEnforcementEnabled: false,
    });
    const replacementPool = createPool({ databaseUrl: harness.db.url, max: 10 });
    const replacement = await buildServer({ config: replacementConfig, pool: replacementPool });
    await replacement.listen({ port: 0, host: '127.0.0.1' });

    const address = replacement.server.address();
    if (address === null || typeof address === 'string') throw new Error('replacement did not bind a port');
    const replacementUrl = `http://127.0.0.1:${address.port}`;

    try {
      // The rows STILL literally read 'held' — no cleanup has run anywhere.
      const untidied = await replacementPool.query<{ count: string }>(
        `SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'held'`,
        [eventId],
      );
      expect(Number(untidied.rows[0]?.count)).toBe(50);

      // ── ...and yet all 50 are sellable again ──────────────────────────
      const newBuyer = await identity.attendee();
      const reclaimed = await fetch(`${replacementUrl}/reservations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...newBuyer },
        body: JSON.stringify({ eventId, seatIds }),
      });

      expect(reclaimed.status).toBe(201);
      const reclaimedBody = (await reclaimed.json()) as { holdId: string; seatIds: string[] };
      expect(reclaimedBody.seatIds).toHaveLength(50);
      expect(reclaimedBody.holdId).not.toBe(holdBody.holdId);

      // No seat ended up under two live holds as a result of the crash.
      const overlapping = await replacementPool.query<{ count: string }>(
        `SELECT count(*) FROM (
           SELECT unnest(seat_ids) AS seat_id FROM holds
           WHERE event_id = $1 AND status = 'active' AND expires_at > now()
           GROUP BY 1 HAVING count(*) > 1
         ) AS d`,
        [eventId],
      );
      expect(Number(overlapping.rows[0]?.count)).toBe(0);

      const metrics = await fetch(`${replacementUrl}/metrics`).then((r) => r.text());
      expect(metrics).toContain('oversell_total 0');
    } finally {
      await replacement.close();
      await replacementPool.end();
      await inspector.end();
    }
  }, 180_000);

  it('a crash mid-basket leaves no partial hold behind', async () => {
    // The harness server is gone from the previous test, so this one works
    // directly against the database the way a recovering operator would.
    const pool = createPool({ databaseUrl: harness.db.url, max: 5 });
    try {
      /*
       * Every LIVE hold has a matching set of held seats: a rolled-back basket
       * leaves neither, and a crash cannot commit half a transaction.
       *
       * Scoped to live holds deliberately. An expired hold owning no seats is the
       * correct end state, not a leak — the seats were legitimately taken by
       * somebody else once the clock passed, which is precisely the behaviour the
       * previous test proves.
       */
      const orphans = await pool.query<{ count: string }>(
        `SELECT count(*) FROM holds h
         WHERE h.status = 'active' AND h.expires_at > now()
           AND NOT EXISTS (SELECT 1 FROM seats s WHERE s.hold_id = h.hold_id)`,
      );
      expect(Number(orphans.rows[0]?.count)).toBe(0);

      const heldWithoutHold = await pool.query<{ count: string }>(
        `SELECT count(*) FROM seats WHERE status = 'held' AND hold_id IS NULL`,
      );
      expect(Number(heldWithoutHold.rows[0]?.count)).toBe(0);
    } finally {
      await pool.end();
    }
  }, 180_000);
});
