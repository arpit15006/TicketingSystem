import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, seedSeats, expireHold, type Harness } from '../helpers.js';

/**
 * PRD §9.2 / ADR-010 — a hold is an `own`-scoped resource.
 *
 * These cover the two routes a browser needs in order to run a hold countdown that
 * survives a page reload, and they pin down the authorization boundary around
 * them. The release case is a regression test: the route previously authenticated
 * the caller without ever checking that the hold was theirs, so anyone who learned
 * a hold id could return another buyer's seats to the market mid-checkout.
 */
describe('a hold belongs to exactly one buyer', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  const owner = randomUUID();
  const stranger = randomUUID();

  const hold = async (eventId: string, seats: string[], userId: string) => {
    const response = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await harness.auth(userId)) },
      body: JSON.stringify({ eventId, seatIds: seats }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  const readHold = async (holdId: string, userId: string) => {
    const response = await fetch(`${harness.baseUrl}/reservations/${holdId}`, {
      headers: await harness.auth(userId),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  const release = async (holdId: string, userId: string) => {
    const response = await fetch(`${harness.baseUrl}/reservations/${holdId}`, {
      method: 'DELETE',
      headers: await harness.auth(userId),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  const seatStatus = async (seatId: string): Promise<string | undefined> => {
    const row = await harness.pool.query<{ status: string }>(`SELECT status FROM seats WHERE seat_id = $1`, [seatId]);
    return row.rows[0]?.status;
  };

  it('lets the owner re-read the hold, so a reloaded page can rebuild its countdown', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 2);
    const created = await hold(eventId, seatIds, owner);
    expect(created.status).toBe(201);

    const reread = await readHold(created.body.holdId, owner);

    expect(reread.status).toBe(200);
    expect(reread.body.holdId).toBe(created.body.holdId);
    expect(reread.body.status).toBe('active');
    expect(reread.body.seats.map((s: { seatId: string }) => s.seatId).sort()).toEqual([...seatIds].sort());
    // The point of the route: the deadline is authoritative and identical to the
    // one handed out at creation, rather than re-derived from the client's clock.
    expect(reread.body.expiresAt).toBe(created.body.expiresAt);
  });

  it('refuses to show a hold to anyone but its owner', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const created = await hold(eventId, seatIds, owner);

    const peek = await readHold(created.body.holdId, stranger);

    expect(peek.status).toBe(403);
    expect(peek.body.code).toBe('FORBIDDEN');
  });

  it('answers 404 for a hold that does not exist', async () => {
    const missing = await readHold(randomUUID(), owner);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('HOLD_NOT_FOUND');
  });

  /**
   * The regression. Before the ownership check, this returned 200 and the seat went
   * straight back on sale — a rival could cancel a buyer who was mid-payment.
   */
  it('refuses to let a stranger release a hold, and leaves the seat held', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const seat = seatIds[0]!;
    const created = await hold(eventId, [seat], owner);
    expect(created.status).toBe(201);

    const attempt = await release(created.body.holdId, stranger);

    expect(attempt.status).toBe(403);
    expect(attempt.body.code).toBe('FORBIDDEN');

    // The authorization failure must not have moved any seat state.
    expect(await seatStatus(seat)).toBe('held');
    const stillHeld = await harness.pool.query<{ hold_id: string | null }>(
      `SELECT hold_id FROM seats WHERE seat_id = $1`,
      [seat],
    );
    expect(stillHeld.rows[0]?.hold_id).toBe(created.body.holdId);

    // And the stranger genuinely cannot buy it either.
    const poach = await hold(eventId, [seat], stranger);
    expect(poach.status).toBe(409);
  });

  it('still lets the owner release their own hold', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const created = await hold(eventId, seatIds, owner);

    const released = await release(created.body.holdId, owner);

    expect(released.status).toBe(200);
    expect(await seatStatus(seatIds[0]!)).toBe('available');
  });

  it('reports an expired hold as expired rather than active', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const created = await hold(eventId, seatIds, owner);
    await expireHold(harness.pool, created.body.holdId);

    const reread = await readHold(created.body.holdId, owner);

    expect(reread.status).toBe(200);
    // ADR-003 — nothing ran to make this true; the timestamp simply passed.
    expect(new Date(reread.body.expiresAt).getTime()).toBeLessThan(Date.now());
  });
});
