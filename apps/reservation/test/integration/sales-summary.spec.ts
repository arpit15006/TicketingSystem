import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, seedSeats, expireHold, type Harness } from '../helpers.js';

/**
 * PRD §13 — the organizer dashboard's live sales figure.
 *
 * The interesting assertion is the last one: an expired hold must be counted as
 * available, not held. ADR-003 makes expiry a predicate, so the seat *row* still
 * reads `held` long after the deadline passes. A dashboard that trusted the column
 * would show an organizer a sold-out house that buyers can actually still book
 * into, and the discrepancy would appear only when the janitor is off — which is
 * exactly when nothing is supposed to break.
 */
describe('sales summary counts what a buyer can actually book', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  const buyer = randomUUID();

  /** An organizer grant naming this specific event — never a flat global role. */
  const organizerFor = async (eventId: string): Promise<Record<string, string>> => ({
    authorization: `Bearer ${await harness.identity.mint({
      roles: [{ role: 'organizer', resourceType: 'event', resourceId: eventId }],
    })}`,
  });

  const hold = async (eventId: string, seats: string[]) => {
    const response = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await harness.auth(buyer)) },
      body: JSON.stringify({ eventId, seatIds: seats }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  const sales = async (eventId: string, headers: Record<string, string>) => {
    const response = await fetch(`${harness.baseUrl}/inventory/${eventId}/sales`, { headers });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  it('partitions the inventory into sold, held and available', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 10);
    const headers = await organizerFor(eventId);

    // Nothing has happened yet.
    const fresh = await sales(eventId, headers);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ total: 10, sold: 0, held: 0, available: 10 });

    // Two seats sold, via the real finalize path.
    const sold = await hold(eventId, seatIds.slice(0, 2));
    expect(sold.status).toBe(201);
    const finalize = await fetch(`${harness.baseUrl}/reservations/${sold.body.holdId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...harness.serviceHeaders },
      body: JSON.stringify({ orderId: randomUUID() }),
    });
    expect(finalize.status).toBe(200);

    // Three more held and still live.
    const held = await hold(eventId, seatIds.slice(2, 5));
    expect(held.status).toBe(201);

    const after = await sales(eventId, headers);
    expect(after.body).toMatchObject({ total: 10, sold: 2, held: 3, available: 5 });
    // The three buckets must account for every seat, always.
    expect(after.body.sold + after.body.held + after.body.available).toBe(after.body.total);
  });

  it('counts an expired hold as available, even though the row still says held', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 4);
    const headers = await organizerFor(eventId);

    const created = await hold(eventId, seatIds.slice(0, 3));
    expect(created.status).toBe(201);
    expect((await sales(eventId, headers)).body).toMatchObject({ total: 4, held: 3, available: 1 });

    await expireHold(harness.pool, created.body.holdId);

    // The janitor has not run. The column is unchanged...
    const raw = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'held'`,
      [eventId],
    );
    expect(Number(raw.rows[0]?.count)).toBe(3);

    // ...and yet the dashboard correctly reports all four seats as sellable,
    // which is what /availability would hand a buyer.
    const after = await sales(eventId, headers);
    expect(after.body).toMatchObject({ total: 4, sold: 0, held: 0, available: 4 });

    const bookable = (await fetch(`${harness.baseUrl}/availability?eventId=${eventId}`).then((r) => r.json())) as {
      available: number;
    };
    expect(bookable.available).toBe(after.body.available);
  });

  it('refuses an attendee, and an organizer grant for a different event', async () => {
    const { eventId } = await seedSeats(harness.pool, 2);

    const asAttendee = await sales(eventId, await harness.auth(buyer));
    expect(asAttendee.status).toBe(403);

    // A real organizer, but for somebody else's show.
    const asWrongOrganizer = await sales(eventId, await organizerFor(randomUUID()));
    expect(asWrongOrganizer.status).toBe(403);
  });

  it('answers 404 for an event with no inventory', async () => {
    const eventId = randomUUID();
    const missing = await sales(eventId, await organizerFor(eventId));
    expect(missing.status).toBe(404);
  });
});
