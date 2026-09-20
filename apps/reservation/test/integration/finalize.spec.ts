import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, seedSeats, userHeaders, expireHold, type Harness } from '../helpers.js';

/** PRD §8.3 — finalization, and the 410 that triggers the compensation path. */
describe('finalize', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);
  afterAll(async () => {
    await harness.stop();
  });

  const hold = async (eventId: string, seats: string[]): Promise<any> => {
    const response = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...userHeaders() },
      body: JSON.stringify({ eventId, seatIds: seats }),
    });
    return response.json();
  };

  const finalize = async (holdId: string, orderId: string): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${harness.baseUrl}/reservations/${holdId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    return { status: response.status, body: await response.json() };
  };

  it('sells the seats and writes SeatSold in the same transaction', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 3);
    const created = await hold(eventId, [seatIds[0]!, seatIds[1]!]);
    const orderId = randomUUID();

    const result = await finalize(created.holdId, orderId);
    expect(result.status).toBe(200);
    expect(result.body.soldSeatIds).toHaveLength(2);

    const sold = await harness.pool.query<{ status: string; order_id: string; held_until: Date | null }>(
      `SELECT status, order_id, held_until FROM seats WHERE seat_id = ANY($1)`,
      [[seatIds[0], seatIds[1]]],
    );
    expect(sold.rows.every((r) => r.status === 'sold')).toBe(true);
    expect(sold.rows.every((r) => r.order_id === orderId)).toBe(true);
    expect(sold.rows.every((r) => r.held_until === null)).toBe(true);

    const holdRow = await harness.pool.query<{ status: string }>(`SELECT status FROM holds WHERE hold_id = $1`, [
      created.holdId,
    ]);
    expect(holdRow.rows[0]?.status).toBe('converted');

    // ADR-005 — the event exists because the same transaction wrote it.
    const outbox = await harness.pool.query<{ payload: { orderId: string } }>(
      `SELECT payload FROM outbox WHERE event_type = 'SeatSold' AND aggregate_id = $1`,
      [eventId],
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0]?.payload.orderId).toBe(orderId);
  });

  it('returns 410 when the hold expired before payment settled', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const created = await hold(eventId, [seatIds[0]!]);
    await expireHold(harness.pool, created.holdId);

    // This is the payment-after-expiry race (ADR-008). The orders service reads
    // this 410 as "enter the compensation path".
    const result = await finalize(created.holdId, randomUUID());
    expect(result.status).toBe(410);
    expect(result.body.code).toBe('SEAT_LOST');

    // Nothing may have been half-sold.
    const seat = await harness.pool.query<{ status: string }>(`SELECT status FROM seats WHERE seat_id = $1`, [seatIds[0]]);
    expect(seat.rows[0]?.status).toBe('held');

    const sold = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'sold'`,
      [eventId],
    );
    expect(Number(sold.rows[0]?.count)).toBe(0);

    const outbox = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM outbox WHERE event_type = 'SeatSold' AND aggregate_id = $1`,
      [eventId],
    );
    expect(Number(outbox.rows[0]?.count)).toBe(0);
  });

  it('rolls back entirely when only part of the basket survives', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 2);
    const created = await hold(eventId, [seatIds[0]!, seatIds[1]!]);

    // Simulate one seat of the basket being lost: expire just that row. The other
    // seat is still validly held, so this is a genuine partial-loss.
    await harness.pool.query(`UPDATE seats SET held_until = now() - interval '1 second' WHERE seat_id = $1`, [seatIds[0]]);

    const result = await finalize(created.holdId, randomUUID());
    expect(result.status).toBe(410);

    // PRD §8.3 — no partial sale may be committed. The survivor must NOT be sold.
    const sold = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'sold'`,
      [eventId],
    );
    expect(Number(sold.rows[0]?.count)).toBe(0);
  });

  it('cannot finalize the same hold under two different orders', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    const created = await hold(eventId, [seatIds[0]!]);

    const firstOrder = randomUUID();
    const first = await finalize(created.holdId, firstOrder);
    expect(first.status).toBe(200);

    // INV-1 stated as an API contract: the seat is sold, so the second order
    // finds nothing to take and gets 410 rather than stealing it.
    const second = await finalize(created.holdId, randomUUID());
    expect(second.status).toBe(410);

    const seat = await harness.pool.query<{ order_id: string }>(`SELECT order_id FROM seats WHERE seat_id = $1`, [
      seatIds[0],
    ]);
    expect(seat.rows[0]?.order_id).toBe(firstOrder);

    const metrics = await fetch(`${harness.baseUrl}/metrics`).then((r) => r.text());
    expect(metrics).toContain('oversell_total 0');
  });

  it('returns 404 for a hold that never existed', async () => {
    const result = await finalize(randomUUID(), randomUUID());
    expect(result.status).toBe(404);
  });
});
