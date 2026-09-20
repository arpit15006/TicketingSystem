import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, global, scoped, type Harness } from '../helpers.js';

/**
 * `price_paise` is BIGINT, and node-postgres returns BIGINT as a **string** so
 * that values past Number.MAX_SAFE_INTEGER survive the round trip. Every route
 * that hands a price to a client must therefore normalise it.
 *
 * This is not pedantry about types. Passed through as a string, a client adding
 * up a basket concatenates instead of summing: three seats at ₹2,500 rendered as
 * ₹2,50,00,02,50,00,02,500. TypeScript cannot catch it, because the value only
 * becomes a string on the wire, where it is unvalidated JSON either way — so it
 * is caught here instead, at the boundary that produces it.
 */
describe('prices cross the wire as numbers', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  const seedEvent = async (): Promise<{ eventId: string; organizerId: string }> => {
    const organizerId = randomUUID();
    const venue = await harness.request('POST', '/venues', {
      headers: await harness.as([global('venue_admin')]),
      body: { name: 'Price Arena', address: '1 Road', city: 'Mumbai' },
    });
    const event = await harness.request('POST', '/events', {
      headers: await harness.as([global('organizer')], organizerId),
      body: {
        venueId: venue.body.venue_id,
        title: 'Pricing Test',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    return { eventId: event.body.event_id as string, organizerId };
  };

  const addTier = async (eventId: string, organizerId: string, name: string, pricePaise: number) =>
    harness.request('POST', `/events/${eventId}/tiers`, {
      headers: await harness.as([scoped('organizer', 'event', eventId)], organizerId),
      body: { name, pricePaise },
    });

  it('returns a number from POST /events/:id/tiers', async () => {
    const { eventId, organizerId } = await seedEvent();

    const created = await addTier(eventId, organizerId, 'Gold', 500_000);

    expect(created.status).toBe(201);
    expect(typeof created.body.price_paise).toBe('number');
    expect(created.body.price_paise).toBe(500_000);
  });

  it('returns numbers from GET /events/:id, so a basket sums instead of concatenating', async () => {
    const { eventId, organizerId } = await seedEvent();
    await addTier(eventId, organizerId, 'Gold', 500_000);
    await addTier(eventId, organizerId, 'Silver', 250_000);

    const detail = await harness.request('GET', `/events/${eventId}`);
    expect(detail.status).toBe(200);

    const tiers = detail.body.tiers as { name: string; price_paise: unknown }[];
    expect(tiers).toHaveLength(2);
    for (const tier of tiers) {
      expect(typeof tier.price_paise).toBe('number');
    }

    // The exact failure a client hit: `+` over three Silver seats.
    const silver = tiers.find((t) => t.name === 'Silver')?.price_paise as number;
    const basket = silver + silver + silver;
    expect(basket).toBe(750_000);
    // Not "250000250000250000".
    expect(String(basket)).toHaveLength(6);
  });

  it('returns numbers from the seatmap, including on a cache hit', async () => {
    const { eventId, organizerId } = await seedEvent();
    const tier = await addTier(eventId, organizerId, 'Gold', 500_000);

    await harness.request('POST', `/events/${eventId}/sections`, {
      headers: await harness.as([scoped('venue_admin', 'venue', (await harness.pool.query<{ venue_id: string }>(
        `SELECT venue_id FROM events WHERE event_id = $1`, [eventId],
      )).rows[0]!.venue_id)], organizerId),
      body: { tierId: tier.body.tier_id, name: 'LOWER', rowCount: 2, seatsPerRow: 2 },
    });

    // First read populates the cache; the second is served from it. Both must
    // agree, or the bug would appear only after the cache warmed.
    const cold = await harness.request('GET', `/events/${eventId}/seatmap`);
    const warm = await harness.request('GET', `/events/${eventId}/seatmap`);

    for (const response of [cold, warm]) {
      expect(response.status).toBe(200);
      const sections = response.body.sections as { price_paise: unknown }[];
      expect(sections.length).toBeGreaterThan(0);
      for (const section of sections) {
        expect(typeof section.price_paise).toBe('number');
      }
    }
  });
});
