import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fireConcurrentRequests, countByStatus } from '@ticketing/testkit';
import { startHarness, seedSeats, type Harness } from '../helpers.js';

/** PRD §8.1 — "Partial baskets are not allowed." */
describe('basket atomicity', () => {
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

  it('holds nothing at all when one seat of the basket is taken', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 4);

    const blocker = await hold(eventId, [seatIds[2]!]);
    expect(blocker.status).toBe(201);

    const basket = await hold(eventId, [seatIds[0]!, seatIds[1]!, seatIds[2]!, seatIds[3]!]);
    expect(basket.status).toBe(409);
    expect(basket.body.details.unavailableSeatIds).toEqual([seatIds[2]]);

    // The three available seats must remain untouched — a buyer who asked for four
    // seats together does not want two, and must not be charged for holding them.
    const stillFree = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE seat_id = ANY($1) AND status = 'available'`,
      [[seatIds[0], seatIds[1], seatIds[3]]],
    );
    expect(Number(stillFree.rows[0]?.count)).toBe(3);

    // The rolled-back attempt left no hold row and no event behind.
    const holds = await harness.pool.query<{ count: string }>(`SELECT count(*) FROM holds WHERE event_id = $1`, [eventId]);
    expect(Number(holds.rows[0]?.count)).toBe(1);
    const outbox = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM outbox WHERE aggregate_id = $1`,
      [eventId],
    );
    expect(Number(outbox.rows[0]?.count)).toBe(1);
  });

  it('gives an adjacent-seat basket to exactly one of many contenders', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 4);
    const basket = seatIds.slice(0, 4);
    const tokens = await Promise.all(Array.from({ length: 25 }, () => harness.auth()));

    // 200 buyers all want the same four seats together. Overlapping multi-row
    // updates are also where deadlocks would show up if the retry were missing.
    const results = await fireConcurrentRequests({
      baseUrl: harness.baseUrl,
      count: 200,
      build: (index) => ({
        method: 'POST',
        path: '/reservations',
        headers: tokens[index % tokens.length]!,
        body: { eventId, seatIds: basket },
      }),
    });

    const statuses = countByStatus(results);
    expect(statuses[201]).toBe(1);
    expect(statuses[409]).toBe(199);

    const held = await harness.pool.query<{ hold_id: string; count: string }>(
      `SELECT hold_id, count(*) AS count FROM seats WHERE event_id = $1 AND status = 'held' GROUP BY hold_id`,
      [eventId],
    );
    // All four seats under ONE hold — never split across two winners.
    expect(held.rowCount).toBe(1);
    expect(Number(held.rows[0]?.count)).toBe(4);
  }, 120_000);

  it('rejects a basket larger than the configured maximum', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 12);
    const tooMany = await hold(eventId, seatIds.slice(0, 11));
    expect(tooMany.status).toBe(422);
  });

  it('rejects a request that specifies neither seats nor a tier', async () => {
    const { eventId } = await seedSeats(harness.pool, 1);
    const response = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await harness.auth()) },
      body: JSON.stringify({ eventId }),
    });
    expect(response.status).toBe(422);
  });

  it('requires an authenticated caller', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const response = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId, seatIds: [seatIds[0]] }),
    });
    expect(response.status).toBe(401);
  });
});
