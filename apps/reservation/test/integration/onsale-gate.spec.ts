import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, seedSeats, type Harness } from '../helpers.js';
import { startFakeCatalog, type FakeCatalog } from '../segment-helpers.js';

/**
 * Seats are for sale only while catalog says the event is on sale.
 *
 * Without the gate, anyone with a token could hold — and through orders, buy —
 * seats on a draft event by calling the API directly; the on-sale moment would be
 * a suggestion the UI happened to honour. The gate fails OPEN when catalog does
 * not answer, because it is sales policy rather than allocation correctness and a
 * dependency outage must never close the door on buyers (INV-7's spirit).
 */
describe('holds are refused before an event is on sale', () => {
  let harness: Harness;
  let catalog: FakeCatalog;

  beforeAll(async () => {
    catalog = await startFakeCatalog();
    harness = await startHarness({ catalogUrl: catalog.url });
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
    await catalog.stop();
  });

  const hold = async (eventId: string, seatIds: string[]) => {
    const response = await fetch(`${harness.baseUrl}/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await harness.auth()) },
      body: JSON.stringify({ eventId, seatIds }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  it.each(['draft', 'published', 'closed'] as const)('refuses a hold on a %s event', async (status) => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    catalog.setEvent(eventId, { allocationMode: 'whole', status });

    const attempt = await hold(eventId, seatIds);

    expect(attempt.status).toBe(409);
    expect(attempt.body.code).toBe('EVENT_NOT_ON_SALE');
    expect(attempt.body.details.status).toBe(status);

    // Nothing moved.
    const seat = await harness.pool.query<{ status: string }>(`SELECT status FROM seats WHERE seat_id = $1`, [seatIds[0]]);
    expect(seat.rows[0]?.status).toBe('available');
  });

  it('allows a hold once the event is on sale', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    catalog.setEvent(eventId, { allocationMode: 'whole', status: 'onsale' });

    expect((await hold(eventId, seatIds)).status).toBe(201);
  });

  it('fails open when catalog does not state a status', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    // A response without the field — older catalog, or a partial outage.
    catalog.setEvent(eventId, { allocationMode: 'whole' });

    expect((await hold(eventId, seatIds)).status).toBe(201);
  });

  it('fails open when catalog is unreachable entirely', async () => {
    const { eventId, seatIds } = await seedSeats(harness.pool, 1);
    // No event registered → the fake returns 404 → the loader falls back.

    expect((await hold(eventId, seatIds)).status).toBe(201);
  });
});
