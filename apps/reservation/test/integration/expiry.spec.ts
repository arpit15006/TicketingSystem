import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, seedSeats, expireHold, type Harness } from '../helpers.js';

/**
 * INV-5 — an expired hold never blocks another buyer.
 *
 * ADR-003: expiry is a query predicate, so these tests never sleep and never run a
 * janitor. Expiry is forced by writing a past timestamp, which is exactly what the
 * passage of time would have produced. A test that needed the janitor to run would
 * be testing the wrong mechanism — the janitor is cosmetic and disabled here.
 */
describe('hold expiry is a predicate, not a job', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);
  afterAll(async () => {
    await harness.stop();
  });

  const hold = async (eventId: string, seats: string[]): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await harness.auth()) },
      body: JSON.stringify({ eventId, seatIds: seats }),
    });
    return { status: response.status, body: await response.json() };
  };

  it('a second buyer wins the seat the instant the first hold expires', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const seat = seatIds[0]!;

    const first = await hold(eventId, [seat]);
    expect(first.status).toBe(201);

    // While the hold is live, the seat is genuinely unavailable.
    const blocked = await hold(eventId, [seat]);
    expect(blocked.status).toBe(409);

    await expireHold(harness.pool, first.body.holdId);

    // The janitor has NOT run — the row still literally reads 'held'.
    const raw = await harness.pool.query<{ status: string }>(`SELECT status FROM seats WHERE seat_id = $1`, [seat]);
    expect(raw.rows[0]?.status).toBe('held');

    // ...and yet the seat is sellable, because the predicate says so.
    const second = await hold(eventId, [seat]);
    expect(second.status).toBe(201);
    expect(second.body.holdId).not.toBe(first.body.holdId);
  });

  it('reports an expired-but-untidied seat as available', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const first = await hold(eventId, [seatIds[0]!]);
    expect(first.status).toBe(201);

    const duringHold = (await fetch(`${harness.baseUrl}/availability?eventId=${eventId}`).then((r) => r.json())) as { available: number };
    expect(duringHold.available).toBe(0);

    await expireHold(harness.pool, first.body.holdId);

    // ADR-003's stated cost: anything reading availability must apply the same
    // predicate. This asserts that it does.
    const afterExpiry = (await fetch(`${harness.baseUrl}/availability?eventId=${eventId}`).then((r) => r.json())) as { available: number };
    expect(afterExpiry.available).toBe(1);
  });

  it('does not let an expired hold be extended back to life', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const first = await hold(eventId, [seatIds[0]!]);
    await expireHold(harness.pool, first.body.holdId);

    // Extending an expired hold would resurrect a claim on a seat another buyer
    // may already own by now.
    const extend = await fetch(`${harness.baseUrl}/holds/${first.body.holdId}/extend`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await harness.auth()) },
      body: JSON.stringify({ seconds: 600 }),
    });
    expect(extend.status).toBe(409);
  });

  it('extends a live hold and pushes the seat expiry with it', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const first = await hold(eventId, [seatIds[0]!]);

    const extend = await fetch(`${harness.baseUrl}/holds/${first.body.holdId}/extend`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(await harness.auth()) },
      body: JSON.stringify({ seconds: 1200 }),
    });
    expect(extend.status).toBe(200);

    const seat = await harness.pool.query<{ held_until: Date }>(
      `SELECT held_until FROM seats WHERE seat_id = $1`,
      [seatIds[0]],
    );
    const heldUntil = seat.rows[0]?.held_until;
    expect(heldUntil).toBeDefined();
    // Comfortably beyond the original 480s default.
    expect(heldUntil!.getTime() - Date.now()).toBeGreaterThan(900_000);
  });

  it('releasing a hold returns the seat immediately', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const first = await hold(eventId, [seatIds[0]!]);

    const release = await fetch(`${harness.baseUrl}/reservations/${first.body.holdId}`, {
      method: 'DELETE',
      headers: await harness.auth(),
    });
    expect(release.status).toBe(200);

    const seat = await harness.pool.query<{ status: string; hold_id: string | null }>(
      `SELECT status, hold_id FROM seats WHERE seat_id = $1`,
      [seatIds[0]],
    );
    expect(seat.rows[0]?.status).toBe('available');
    expect(seat.rows[0]?.hold_id).toBeNull();

    const again = await hold(eventId, [seatIds[0]!]);
    expect(again.status).toBe(201);
  });
});
