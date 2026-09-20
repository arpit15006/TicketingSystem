import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fireConcurrentRequests, countByStatus, latency, totalConnectRetries } from '@ticketing/testkit';
import { startHarness, seedSeats, type Harness } from '../helpers.js';

/**
 * ============================================================================
 *  THE PROOF — PRD §15.1 / §1.1.2
 * ============================================================================
 *
 *  1,000 genuinely concurrent HTTP requests against 100 seats.
 *  Expected: exactly 100 × 201, exactly 900 × 409, zero oversells.
 *
 *  Requests are real parallel HTTP calls to a real listening server backed by a
 *  real PostgreSQL (PRD §15.2). Concurrency is NOT simulated inside a single
 *  transaction — that would prove nothing about what happens when a thousand
 *  transactions actually collide.
 *
 *  Ten requests target each of the 100 seats, so the arithmetic is exact rather
 *  than probabilistic: every seat is contested, exactly one contender per seat
 *  can win, and any deviation from 100/900 is a real defect rather than noise.
 */

const SEAT_COUNT = 100;
const REQUEST_COUNT = 1000;

describe('oversell: 1000 concurrent requests against 100 seats', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('sells exactly 100 seats, rejects exactly 900, and oversells nothing', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, SEAT_COUNT);
    expect(seatIds).toHaveLength(SEAT_COUNT);

    // Real RS256 bearer tokens, minted before the burst so signing cost is not
    // measured as request latency. Distinct users; allocation does not depend on
    // who is asking, but nothing in the test should imply that it might.
    const tokens = await Promise.all(Array.from({ length: 50 }, () => harness.auth()));

    const results = await fireConcurrentRequests({
      baseUrl: harness.baseUrl,
      count: REQUEST_COUNT,
      build: (index) => ({
        method: 'POST',
        path: '/reservations',
        headers: tokens[index % tokens.length]!,
        // 10 contenders per seat.
        body: { eventId, seatIds: [seatIds[index % SEAT_COUNT]] },
      }),
    });

    const statuses = countByStatus(results);
    const timing = latency(results);

    console.log('\n──────── OVERSELL PROOF ────────');
    console.log(`requests fired      : ${REQUEST_COUNT} (real parallel HTTP)`);
    console.log(`seats available     : ${SEAT_COUNT}`);
    console.log(`status counts       : ${JSON.stringify(statuses)}`);
    console.log(`client latency (ms) : p50=${timing.p50.toFixed(1)} p95=${timing.p95.toFixed(1)} p99=${timing.p99.toFixed(1)} max=${timing.max.toFixed(1)}`);
    console.log(`kernel connect retries: ${totalConnectRetries(results)} (macOS somaxconn=128; never-sent connections only)`);

    // ---- HTTP-level assertions ------------------------------------------------
    expect(statuses[201]).toBe(SEAT_COUNT);
    expect(statuses[409]).toBe(REQUEST_COUNT - SEAT_COUNT);
    expect(Object.keys(statuses).sort()).toEqual(['201', '409']);

    // Every rejection must name the seat that beat it — a 409 with no explanation
    // is useless to a client deciding what to try next.
    const rejected = results.filter((r) => r.status === 409);
    for (const failure of rejected.slice(0, 25)) {
      const body = failure.body as { code: string; details: { unavailableSeatIds: string[] } };
      expect(body.code).toBe('SEATS_UNAVAILABLE');
      expect(body.details.unavailableSeatIds.length).toBeGreaterThan(0);
    }

    // ---- Database-level assertions (PRD §15.1) --------------------------------
    const held = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE status = 'held' AND held_until > now()`,
    );
    expect(Number(held.rows[0]?.count)).toBe(SEAT_COUNT);

    // INV-1: no seat sold twice. Nothing is sold yet, so nothing may be.
    const sold = await harness.pool.query<{ count: string }>(`SELECT count(*) FROM seats WHERE status = 'sold'`);
    expect(Number(sold.rows[0]?.count)).toBe(0);

    // INV-2: no seat carries more than one hold, and no two holds share a seat.
    const seatsPerHold = await harness.pool.query<{ hold_id: string; seats: string }>(
      `SELECT hold_id, count(*) AS seats FROM seats WHERE status = 'held' GROUP BY hold_id`,
    );
    expect(seatsPerHold.rowCount).toBe(SEAT_COUNT);
    for (const row of seatsPerHold.rows) expect(Number(row.seats)).toBe(1);

    // A losing attempt must leave no trace: its hold row rolled back with it.
    const holds = await harness.pool.query<{ count: string }>(`SELECT count(*) FROM holds WHERE status = 'active'`);
    expect(Number(holds.rows[0]?.count)).toBe(SEAT_COUNT);

    // Overlapping holds on one seat, stated directly as SQL.
    const overlapping = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM (
         SELECT s.seat_id FROM seats s
         JOIN holds h ON s.seat_id = ANY (h.seat_ids) AND h.status = 'active' AND h.expires_at > now()
         GROUP BY s.seat_id HAVING count(DISTINCT h.hold_id) > 1
       ) AS d`,
    );
    expect(Number(overlapping.rows[0]?.count)).toBe(0);

    // Exactly one outbox event per winning hold, written in the same transaction.
    const outbox = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM outbox WHERE event_type = 'SeatHeld'`,
    );
    expect(Number(outbox.rows[0]?.count)).toBe(SEAT_COUNT);

    // ---- The published invariant ---------------------------------------------
    const metrics = await fetch(`${harness.baseUrl}/metrics`).then((r) => r.text());
    expect(metrics).toContain('oversell_total 0');

    // ---- Proof that the contention was REAL ----------------------------------
    // Counting client sockets does not prove transactions collided; the kernel can
    // serialize them. This is measured inside the service, where the race happens.
    const peak = Number(/seat_hold_inflight_peak (\d+)/.exec(metrics)?.[1] ?? '0');
    console.log(`peak concurrent allocations in-flight: ${peak}`);
    expect(peak).toBeGreaterThan(10);

    console.log('oversell_total      : 0  ✅\n');
  }, 180_000);

  it('general admission under the same contention allocates each seat once', async () => {
    const { eventId, tierId } = await seedSeats(harness.pool, SEAT_COUNT);
    const tokens = await Promise.all(Array.from({ length: 50 }, () => harness.auth()));

    // The FOR UPDATE SKIP LOCKED path (PRD §8.1): 1,000 buyers asking for "any seat"
    // rather than a chosen one. Without SKIP LOCKED these serialize on one row.
    const results = await fireConcurrentRequests({
      baseUrl: harness.baseUrl,
      count: REQUEST_COUNT,
      build: (index) => ({
        method: 'POST',
        path: '/reservations',
        headers: tokens[index % tokens.length]!,
        body: { eventId, tierId, quantity: 1 },
      }),
    });

    const statuses = countByStatus(results);
    console.log(`GA status counts    : ${JSON.stringify(statuses)}`);

    expect(statuses[201]).toBe(SEAT_COUNT);
    expect(statuses[409]).toBe(REQUEST_COUNT - SEAT_COUNT);

    const held = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'held' AND held_until > now()`,
      [eventId],
    );
    expect(Number(held.rows[0]?.count)).toBe(SEAT_COUNT);

    // No seat may appear in two different holds.
    const duplicated = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM (
         SELECT unnest(seat_ids) AS seat_id FROM holds WHERE event_id = $1 AND status = 'active'
         GROUP BY 1 HAVING count(*) > 1
       ) AS d`,
      [eventId],
    );
    expect(Number(duplicated.rows[0]?.count)).toBe(0);
  }, 180_000);
});
