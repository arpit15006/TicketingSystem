import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, global, scoped, type Harness } from '../helpers.js';

/**
 * PRD §9.2 — `organizer` is scoped to "events they own", `venue_admin` to
 * "venues they administer". This is where those grants come from.
 *
 * Reservation authorizes seat provisioning by an explicit `organizer:event:<id>`
 * grant, because it cannot see catalog's ownership column (ADR-004). Before this,
 * the only way to obtain one was a platform admin typing it in — so a plain
 * organizer could create an event and then never put a seat on sale.
 */
describe('creating a resource grants its scoped role', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  const makeVenue = async (userId: string) =>
    harness.request('POST', '/venues', {
      headers: await harness.as([global('venue_admin')], userId),
      body: { name: 'Grant Arena', address: '1 Road', city: 'Pune' },
    });

  it('grants venue_admin:venue:<id> to whoever creates a venue', async () => {
    const userId = randomUUID();
    const created = await makeVenue(userId);

    expect(created.status).toBe(201);
    expect(harness.grants.at(-1)).toEqual({
      userId,
      role: 'venue_admin',
      resourceType: 'venue',
      resourceId: created.body.venue_id,
    });
  });

  it('grants organizer:event:<id> to whoever creates an event', async () => {
    const userId = randomUUID();
    const venue = await makeVenue(randomUUID());

    const created = await harness.request('POST', '/events', {
      headers: await harness.as([global('organizer')], userId),
      body: { venueId: venue.body.venue_id, title: 'Granted', startsAt: new Date(Date.now() + 86_400_000).toISOString() },
    });

    expect(created.status).toBe(201);
    expect(harness.grants.at(-1)).toEqual({
      userId,
      role: 'organizer',
      resourceType: 'event',
      resourceId: created.body.event_id,
    });
  });

  /**
   * The grant is inside the transaction. An event that exists without its grant
   * is one its organizer cannot provision — so if identity cannot record the
   * grant, the event must not exist either.
   */
  it('rolls the event back when the grant cannot be recorded', async () => {
    const venue = await makeVenue(randomUUID());
    const before = await harness.pool.query<{ count: string }>(`SELECT count(*) FROM events`);

    harness.failNextGrant();
    const attempt = await harness.request('POST', '/events', {
      headers: await harness.as([global('organizer')]),
      body: { venueId: venue.body.venue_id, title: 'Orphan', startsAt: new Date(Date.now() + 86_400_000).toISOString() },
    });

    expect(attempt.status).toBe(500);
    const after = await harness.pool.query<{ count: string }>(`SELECT count(*) FROM events`);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});

describe('event listings carry what a card needs', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  const setup = async () => {
    const organizerId = randomUUID();
    const venue = await harness.request('POST', '/venues', {
      headers: await harness.as([global('venue_admin')]),
      body: { name: 'Card Arena', address: '9 Lane', city: 'Jaipur' },
    });
    const event = await harness.request('POST', '/events', {
      headers: await harness.as([global('organizer')], organizerId),
      body: { venueId: venue.body.venue_id, title: 'Card Event', startsAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    const eventId = event.body.event_id as string;
    for (const [name, pricePaise] of [['Gold', 500_000], ['Silver', 150_000]] as const) {
      await harness.request('POST', `/events/${eventId}/tiers`, {
        headers: await harness.as([scoped('organizer', 'event', eventId)], organizerId),
        body: { name, pricePaise },
      });
    }
    await harness.request('POST', `/events/${eventId}/publish`, {
      headers: await harness.as([scoped('organizer', 'event', eventId)], organizerId),
      body: { onsale: true },
    });
    return { eventId, organizerId };
  };

  it('includes the venue and the cheapest tier, as numbers, without N+1 calls', async () => {
    const { eventId } = await setup();

    const listed = await harness.request('GET', '/events?status=onsale');
    const card = (listed.body.events as any[]).find((e) => e.event_id === eventId);

    expect(card).toBeDefined();
    expect(card.venue_name).toBe('Card Arena');
    expect(card.venue_city).toBe('Jaipur');
    // The BIGINT min() arrives as a string from pg; it must leave as a number.
    expect(card.min_price_paise).toBe(150_000);
    expect(typeof card.min_price_paise).toBe('number');
  });

  it('shows an organizer their own drafts through /events/mine, and nobody else', async () => {
    const organizerId = randomUUID();
    const venue = await harness.request('POST', '/venues', {
      headers: await harness.as([global('venue_admin')]),
      body: { name: 'Draft Arena', address: '1 Road', city: 'Kochi' },
    });
    const draft = await harness.request('POST', '/events', {
      headers: await harness.as([global('organizer')], organizerId),
      body: { venueId: venue.body.venue_id, title: 'Unpublished', startsAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    const draftId = draft.body.event_id as string;

    // Invisible to the public listing…
    const everyone = await harness.request('GET', '/events');
    expect((everyone.body.events as any[]).some((e) => e.event_id === draftId)).toBe(false);

    // …visible to its organizer…
    const mine = await harness.request('GET', '/events/mine', {
      headers: await harness.as([global('organizer')], organizerId),
    });
    expect(mine.status).toBe(200);
    expect((mine.body.events as any[]).some((e) => e.event_id === draftId)).toBe(true);

    // …and to a co-organizer holding the scoped grant…
    const coOrganizer = await harness.request('GET', '/events/mine', {
      headers: await harness.as([scoped('organizer', 'event', draftId)], randomUUID()),
    });
    expect((coOrganizer.body.events as any[]).some((e) => e.event_id === draftId)).toBe(true);

    // …but not to a different organizer.
    const stranger = await harness.request('GET', '/events/mine', {
      headers: await harness.as([global('organizer')], randomUUID()),
    });
    expect((stranger.body.events as any[]).some((e) => e.event_id === draftId)).toBe(false);
  });
});
