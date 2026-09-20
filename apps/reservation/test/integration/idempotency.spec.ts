import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fireConcurrentRequests, countByStatus } from '@ticketing/testkit';
import { startHarness, seedSeats, type Harness } from '../helpers.js';

/** PRD §15.1 / ADR-009 — idempotency is a correctness property, not a convenience. */
describe('idempotency', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);
  afterAll(async () => {
    await harness.stop();
  });

  const post = async (body: unknown, headers: Record<string, string>): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  it('same key + same body returns the identical response and creates exactly one hold', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 5);
    const headers = { ...(await harness.auth()), 'idempotency-key': randomUUID() };
    const body = { eventId, seatIds: [seatIds[0], seatIds[1]] };

    const first = await post(body, headers);
    const second = await post(body, headers);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Identical, not merely similar — same holdId, same expiry.
    expect(second.body).toEqual(first.body);

    const holds = await harness.pool.query<{ count: string }>(`SELECT count(*) FROM holds WHERE event_id = $1`, [eventId]);
    expect(Number(holds.rows[0]?.count)).toBe(1);

    // The replay must not have emitted a second event.
    const outbox = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM outbox WHERE event_type = 'SeatHeld' AND aggregate_id = $1`,
      [eventId],
    );
    expect(Number(outbox.rows[0]?.count)).toBe(1);
  });

  it('same key + different body is rejected with 422 rather than silently replayed', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 5);
    const headers = { ...(await harness.auth()), 'idempotency-key': randomUUID() };

    const first = await post({ eventId, seatIds: [seatIds[0]] }, headers);
    expect(first.status).toBe(201);

    // ADR-009: reusing a key for a *different* request is a client bug and must
    // surface loudly. Serving the stored response here would hide it.
    const second = await post({ eventId, seatIds: [seatIds[1]] }, headers);
    expect(second.status).toBe(422);
    expect(second.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('replays a deliberate 409 rather than re-running the allocation', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 2);
    const taken = seatIds[0];

    // Someone else takes the seat first.
    const winner = await post({ eventId, seatIds: [taken] }, await harness.auth());
    expect(winner.status).toBe(201);

    const headers = { ...(await harness.auth()), 'idempotency-key': randomUUID() };
    const first = await post({ eventId, seatIds: [taken] }, headers);
    const replay = await post({ eventId, seatIds: [taken] }, headers);

    expect(first.status).toBe(409);
    expect(replay.status).toBe(409);
    // "These seats are gone" is an answer, and the answer must not drift.
    expect(replay.body.code).toBe(first.body.code);
    expect(replay.body.details).toEqual(first.body.details);
  });

  it('concurrent requests sharing one key never both execute', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 3);
    const key = randomUUID();
    const userId = randomUUID();
    const token = await harness.auth(userId);

    // The unique constraint on `key` decides the winner, exactly as the seat
    // allocation lets the database decide (ADR-002).
    const results = await fireConcurrentRequests({
      baseUrl: harness.baseUrl,
      count: 20,
      build: () => ({
        method: 'POST',
        path: '/reservations',
        headers: { ...token, 'idempotency-key': key },
        body: { eventId, seatIds: [seatIds[0]] },
      }),
    });

    const statuses = countByStatus(results);
    // Every response is either the created hold or "still running"; never two holds.
    expect((statuses[201] ?? 0) + (statuses[409] ?? 0)).toBe(20);
    expect(statuses[201] ?? 0).toBeGreaterThanOrEqual(1);

    const holds = await harness.pool.query<{ count: string }>(`SELECT count(*) FROM holds WHERE event_id = $1`, [eventId]);
    expect(Number(holds.rows[0]?.count)).toBe(1);

    const held = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'held'`,
      [eventId],
    );
    expect(Number(held.rows[0]?.count)).toBe(1);
  });

  it('a request without a key is not idempotent and holds different seats each time', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 4);
    const headers = await harness.auth();

    const first = await post({ eventId, seatIds: [seatIds[0]] }, headers);
    const second = await post({ eventId, seatIds: [seatIds[1]] }, headers);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.holdId).not.toBe(first.body.holdId);
  });
});
