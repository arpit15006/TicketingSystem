import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fireConcurrentRequests, countByStatus } from '@ticketing/testkit';
import { startHarness, type Harness } from '../helpers.js';
import { startFakeCatalog, seedSegmentedSeats, expireOccupancies, type FakeCatalog } from '../segment-helpers.js';

/**
 * ============================================================================
 *  PRD §8.4 — the five mandatory segmented-allocation tests
 * ============================================================================
 *
 *  A berth from Delhi to Chennai is not one unit of inventory. Selling
 *  Delhi→Bhopal and Bhopal→Chennai to two passengers is correct and fully
 *  utilises the berth. Availability is therefore an interval-overlap question,
 *  and Postgres answers it at the storage layer.
 */
describe('segmented allocation', () => {
  let harness: Harness;
  let catalog: FakeCatalog;

  beforeAll(async () => {
    catalog = await startFakeCatalog();
    harness = await startHarness({ maxSeatsPerHold: 50, catalogUrl: catalog.url });
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
    await catalog.stop();
  });

  const segmentedEvent = async (seats: number) => {
    const event = await seedSegmentedSeats(harness.pool, seats);
    catalog.setEvent(event.eventId, { allocationMode: 'segmented' });
    return event;
  };

  const hold = async (
    args: { eventId: string; seatIds: string[]; fromStop: number; toStop: number },
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(headers ?? (await harness.auth())) },
      body: JSON.stringify(args),
    });
    return { status: response.status, body: await response.json() };
  };

  /* ───────────────────── segment-disjoint ───────────────────── */

  it('segment-disjoint: two buyers share one seat across [0,3) and [3,7)', async () => {
    const { eventId, seatIds } = await segmentedEvent(1);
    const seatId = seatIds[0]!;

    // Delhi → Bhopal.
    const first = await hold({ eventId, seatIds: [seatId], fromStop: 0, toStop: 3 });
    // Bhopal → Chennai. One alights exactly as the other boards.
    const second = await hold({ eventId, seatIds: [seatId], fromStop: 3, toStop: 7 });

    // THE CAPACITY WIN. Both succeed on the same physical berth.
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.holdId).not.toBe(first.body.holdId);

    const occupancies = await harness.pool.query<{ leg_range: string; state: string }>(
      `SELECT leg_range::text, state FROM seat_occupancies WHERE seat_id = $1 ORDER BY lower(leg_range)`,
      [seatId],
    );
    expect(occupancies.rows.map((r) => r.leg_range)).toEqual(['[0,3)', '[3,7)']);
    expect(occupancies.rows.every((r) => r.state === 'held')).toBe(true);
  });

  /* ───────────────────── segment-overlap ────────────────────── */

  it('segment-overlap: [0,5) and [3,7) on one seat — exactly one succeeds', async () => {
    const { eventId, seatIds } = await segmentedEvent(1);
    const seatId = seatIds[0]!;

    const first = await hold({ eventId, seatIds: [seatId], fromStop: 0, toStop: 5 });
    // Stops 3 and 4 are shared, so this seat cannot carry both journeys.
    const second = await hold({ eventId, seatIds: [seatId], fromStop: 3, toStop: 7 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SEATS_UNAVAILABLE');

    const occupancies = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seat_occupancies WHERE seat_id = $1`,
      [seatId],
    );
    // The loser's transaction rolled back entirely — no orphan occupancy.
    expect(Number(occupancies.rows[0]?.count)).toBe(1);
  });

  /* ─────────────────── segment-concurrency ──────────────────── */

  it('segment-concurrency: 500 concurrent overlapping requests across 50 seats', async () => {
    const SEATS = 50;
    const REQUESTS = 500;
    const { eventId, seatIds } = await segmentedEvent(SEATS);

    const tokens = await Promise.all(Array.from({ length: 25 }, () => harness.auth()));

    // Every request wants legs that overlap every other request's legs, so at
    // most one can win per seat. 10 contenders per seat makes it exact.
    const results = await fireConcurrentRequests({
      baseUrl: harness.baseUrl,
      count: REQUESTS,
      build: (index) => ({
        method: 'POST',
        path: '/reservations',
        headers: tokens[index % tokens.length]!,
        body: {
          eventId,
          seatIds: [seatIds[index % SEATS]],
          // [0,5), [1,6), [2,7) — all mutually overlapping.
          fromStop: index % 3,
          toStop: (index % 3) + 5,
        },
      }),
    });

    const statuses = countByStatus(results);
    console.log('\n──────── SEGMENT CONCURRENCY PROOF ────────');
    console.log(`requests fired : ${REQUESTS} (real parallel HTTP, overlapping legs)`);
    console.log(`seats          : ${SEATS}`);
    console.log(`status counts  : ${JSON.stringify(statuses)}`);

    expect(statuses[201]).toBe(SEATS);
    expect(statuses[409]).toBe(REQUESTS - SEATS);

    // INV-8 stated directly: no seat has two overlapping LIVE occupancies.
    const overlapping = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seat_occupancies a
       JOIN seat_occupancies b
         ON a.seat_id = b.seat_id
        AND a.occupancy_id <> b.occupancy_id
        AND a.leg_range && b.leg_range
       WHERE a.event_id = $1
         AND (a.state = 'sold' OR (a.state = 'held' AND a.held_until > now()))
         AND (b.state = 'sold' OR (b.state = 'held' AND b.held_until > now()))`,
      [eventId],
    );
    expect(Number(overlapping.rows[0]?.count)).toBe(0);

    const total = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seat_occupancies WHERE event_id = $1`,
      [eventId],
    );
    expect(Number(total.rows[0]?.count)).toBe(SEATS);
  }, 180_000);

  /* ──────────────────── segment-exclusion ───────────────────── */

  it('segment-exclusion: the database refuses a conflicting sold row even when the query layer is bypassed', async () => {
    const { eventId, seatIds } = await segmentedEvent(1);
    const seatId = seatIds[0]!;

    // Straight INSERT, bypassing every application check.
    await harness.pool.query(
      `INSERT INTO seat_occupancies (seat_id, event_id, leg_range, state, order_id)
       VALUES ($1, $2, int4range(0, 5, '[)'), 'sold', $3)`,
      [seatId, eventId, randomUUID()],
    );

    /*
     * THE POINT OF THIS TEST.
     *
     * Defence in depth demonstrated rather than claimed: application code can be
     * wrong and the database still refuses to double-sell a segment.
     */
    await expect(
      harness.pool.query(
        `INSERT INTO seat_occupancies (seat_id, event_id, leg_range, state, order_id)
         VALUES ($1, $2, int4range(3, 7, '[)'), 'sold', $3)`,
        [seatId, eventId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23P01', constraint: 'no_sold_segment_overlap' });

    // A disjoint sold segment is still perfectly legal.
    await expect(
      harness.pool.query(
        `INSERT INTO seat_occupancies (seat_id, event_id, leg_range, state, order_id)
         VALUES ($1, $2, int4range(5, 9, '[)'), 'sold', $3)`,
        [seatId, eventId, randomUUID()],
      ),
    ).resolves.toBeDefined();

    // And the constraint covers sold-vs-sold only: a live HELD row overlapping a
    // sold one is accepted by the storage layer, which is exactly why the query
    // plus the row lock exist. `now()` is not IMMUTABLE, so no index predicate
    // can express "live hold".
    await expect(
      harness.pool.query(
        `INSERT INTO seat_occupancies (seat_id, event_id, leg_range, state, hold_id, held_until)
         VALUES ($1, $2, int4range(0, 3, '[)'), 'held', $3, now() + interval '10 minutes')`,
        [seatId, eventId, randomUUID()],
      ),
    ).resolves.toBeDefined();
  });

  /* ───────────────────── segment-expiry ─────────────────────── */

  it('segment-expiry: an expired hold on [0,5) does not block a new hold on [3,7)', async () => {
    const { eventId, seatIds } = await segmentedEvent(1);
    const seatId = seatIds[0]!;

    const first = await hold({ eventId, seatIds: [seatId], fromStop: 0, toStop: 5 });
    expect(first.status).toBe(201);

    // While live, the overlap blocks.
    const blocked = await hold({ eventId, seatIds: [seatId], fromStop: 3, toStop: 7 });
    expect(blocked.status).toBe(409);

    await expireOccupancies(harness.pool, first.body.holdId);

    // The occupancy row is still there and still says 'held' — no reaper ran.
    const stale = await harness.pool.query<{ state: string }>(
      `SELECT state FROM seat_occupancies WHERE hold_id = $1`,
      [first.body.holdId],
    );
    expect(stale.rows[0]?.state).toBe('held');

    // ...and yet the overlapping journey is now sellable, because `held_until >
    // now()` lives in the NOT EXISTS clause. ADR-003 carries over intact.
    const afterExpiry = await hold({ eventId, seatIds: [seatId], fromStop: 3, toStop: 7 });
    expect(afterExpiry.status).toBe(201);
  });

  /* ─────────────────── contract and dispatch ────────────────── */

  it('rejects a span on a whole-seat event and requires one on a segmented event', async () => {
    const whole = await seedSegmentedSeats(harness.pool, 1);
    catalog.setEvent(whole.eventId, { allocationMode: 'whole' });

    const spanOnWhole = await hold({ eventId: whole.eventId, seatIds: [whole.seatIds[0]!], fromStop: 0, toStop: 3 });
    expect(spanOnWhole.status).toBe(422);

    const segmented = await segmentedEvent(1);
    const response = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await harness.auth()) },
      body: JSON.stringify({ eventId: segmented.eventId, seatIds: [segmented.seatIds[0]] }),
    });
    expect(response.status).toBe(422);
  });

  it('finalize and release keep their contracts and dispatch on the data', async () => {
    const { eventId, seatIds } = await segmentedEvent(2);
    const seatId = seatIds[0]!;

    const held = await hold({ eventId, seatIds: [seatId], fromStop: 0, toStop: 4 });
    expect(held.status).toBe(201);

    // Orders calls exactly the same endpoint with exactly the same body as for a
    // whole-seat hold — it has no idea segmented mode exists.
    const orderId = randomUUID();
    const finalize = await fetch(`${harness.baseUrl}/reservations/${held.body.holdId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...harness.serviceHeaders },
      body: JSON.stringify({ orderId }),
    });
    expect(finalize.status).toBe(200);

    const sold = await harness.pool.query<{ state: string; order_id: string }>(
      `SELECT state, order_id FROM seat_occupancies WHERE hold_id = $1`,
      [held.body.holdId],
    );
    expect(sold.rows[0]?.state).toBe('sold');
    expect(sold.rows[0]?.order_id).toBe(orderId);

    // Idempotent, because webhook delivery is at-least-once.
    const replay = await fetch(`${harness.baseUrl}/reservations/${held.body.holdId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...harness.serviceHeaders },
      body: JSON.stringify({ orderId }),
    });
    expect(replay.status).toBe(200);

    // A sold segment is gone for good; the same legs cannot be held again.
    const afterSale = await hold({ eventId, seatIds: [seatId], fromStop: 1, toStop: 3 });
    expect(afterSale.status).toBe(409);

    // Release returns a held segment to the market. Both calls use one identity:
    // `harness.auth()` mints a fresh random user each time, and only the buyer who
    // owns a hold may release it (PRD §9.2).
    const owner = await harness.auth(randomUUID());
    const other = await hold({ eventId, seatIds: [seatIds[1]!], fromStop: 0, toStop: 4 }, owner);
    const released = await fetch(`${harness.baseUrl}/reservations/${other.body.holdId}`, {
      method: 'DELETE',
      headers: owner,
    });
    expect(released.status).toBe(200);

    const remaining = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seat_occupancies WHERE hold_id = $1`,
      [other.body.holdId],
    );
    expect(Number(remaining.rows[0]?.count)).toBe(0);
  });

  it('serves availability for a requested span', async () => {
    const { eventId, seatIds } = await segmentedEvent(5);

    await hold({ eventId, seatIds: [seatIds[0]!], fromStop: 0, toStop: 5 });

    // Overlapping span: the held seat is unavailable.
    const overlapping = await fetch(
      `${harness.baseUrl}/availability?eventId=${eventId}&fromStop=2&toStop=4&limit=10`,
    ).then((r) => r.json() as Promise<{ available: number }>);
    expect(overlapping.available).toBe(4);

    // Disjoint span: every seat is available, including the held one.
    const disjoint = await fetch(
      `${harness.baseUrl}/availability?eventId=${eventId}&fromStop=5&toStop=8&limit=10`,
    ).then((r) => r.json() as Promise<{ available: number }>);
    expect(disjoint.available).toBe(5);
  });
});
