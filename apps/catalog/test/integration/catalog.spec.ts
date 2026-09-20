import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, global, scoped, type Harness } from '../helpers.js';

describe('catalog', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);
  afterAll(async () => {
    await harness.stop();
  });

  const makeVenue = async (): Promise<string> => {
    const headers = await harness.as([global('venue_admin')]);
    const created = await harness.request('POST', '/venues', {
      headers,
      body: { name: 'Test Arena', address: '1 Road', city: 'Mumbai' },
    });
    expect(created.status).toBe(201);
    return created.body.venue_id as string;
  };

  const makeEvent = async (organizerId: string, venueId?: string): Promise<{ eventId: string; venueId: string }> => {
    const venue = venueId ?? (await makeVenue());
    const headers = await harness.as([global('organizer')], organizerId);
    const created = await harness.request('POST', '/events', {
      headers,
      body: { venueId: venue, title: 'A Concert', startsAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(created.status).toBe(201);
    return { eventId: created.body.event_id as string, venueId: venue };
  };

  it('creates a venue only for a caller holding venue:create', async () => {
    const attendee = await harness.as([global('attendee')]);
    const denied = await harness.request('POST', '/venues', {
      headers: attendee,
      body: { name: 'X', address: 'Y', city: 'Z' },
    });
    expect(denied.status).toBe(403);

    const anonymous = await harness.request('POST', '/venues', { body: { name: 'X', address: 'Y', city: 'Z' } });
    expect(anonymous.status).toBe(401);

    await expect(makeVenue()).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records the creator as the event organizer', async () => {
    const organizerId = randomUUID();
    const { eventId } = await makeEvent(organizerId);

    const stored = await harness.pool.query<{ organizer_id: string; status: string }>(
      `SELECT organizer_id, status FROM events WHERE event_id = $1`,
      [eventId],
    );
    expect(stored.rows[0]?.organizer_id).toBe(organizerId);
    expect(stored.rows[0]?.status).toBe('draft');
  });

  /**
   * ADR-010 / PRD §9.2 — the heart of resource-scoped authorization: holding the
   * `organizer` role must NOT grant power over every event.
   */
  it('lets an organizer update their own event and refuses another organizer\'s', async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    const { eventId } = await makeEvent(owner);

    const byOwner = await harness.request('PATCH', `/events/${eventId}`, {
      headers: await harness.as([global('organizer')], owner),
      body: { title: 'Renamed By Owner' },
    });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.title).toBe('Renamed By Owner');

    // Same role, different user. Flat global roles would allow this.
    const byStranger = await harness.request('PATCH', `/events/${eventId}`, {
      headers: await harness.as([global('organizer')], stranger),
      body: { title: 'Hijacked' },
    });
    expect(byStranger.status).toBe(403);

    const unchanged = await harness.request('GET', `/events/${eventId}`);
    expect(unchanged.body.title).toBe('Renamed By Owner');
  });

  it('lets a co-organizer with an explicit event grant update the event', async () => {
    const owner = randomUUID();
    const coOrganizer = randomUUID();
    const { eventId } = await makeEvent(owner);

    // Not the owner, but holds organizer:event:<id> — the case explicit grants exist for.
    const result = await harness.request('PATCH', `/events/${eventId}`, {
      headers: await harness.as([global('organizer'), scoped('organizer', 'event', eventId)], coOrganizer),
      body: { title: 'Updated By Co-organizer' },
    });
    expect(result.status).toBe(200);

    // ...but that grant must not carry over to a different event.
    const other = await makeEvent(owner);
    const spillover = await harness.request('PATCH', `/events/${other.eventId}`, {
      headers: await harness.as([global('organizer'), scoped('organizer', 'event', eventId)], coOrganizer),
      body: { title: 'Should Not Work' },
    });
    expect(spillover.status).toBe(403);
  });

  it('scopes seatmap writes to the venue, not the event', async () => {
    const owner = randomUUID();
    const venueAdmin = randomUUID();
    const { eventId, venueId } = await makeEvent(owner);

    const tier = await harness.request('POST', `/events/${eventId}/tiers`, {
      headers: await harness.as([global('organizer')], owner),
      body: { name: 'Gold', pricePaise: 250_000 },
    });
    expect(tier.status).toBe(201);

    const wrongVenue = await harness.request('POST', `/events/${eventId}/sections`, {
      headers: await harness.as([scoped('venue_admin', 'venue', randomUUID())], venueAdmin),
      body: { tierId: tier.body.tier_id, name: 'A', rowCount: 10, seatsPerRow: 10 },
    });
    expect(wrongVenue.status).toBe(403);

    const rightVenue = await harness.request('POST', `/events/${eventId}/sections`, {
      headers: await harness.as([scoped('venue_admin', 'venue', venueId)], venueAdmin),
      body: { tierId: tier.body.tier_id, name: 'A', rowCount: 10, seatsPerRow: 10 },
    });
    expect(rightVenue.status).toBe(201);
  });

  it('refuses to publish an event that has no pricing tier', async () => {
    const owner = randomUUID();
    const { eventId } = await makeEvent(owner);
    const headers = await harness.as([global('organizer')], owner);

    const tooEarly = await harness.request('POST', `/events/${eventId}/publish`, { headers, body: {} });
    expect(tooEarly.status).toBe(422);

    await harness.request('POST', `/events/${eventId}/tiers`, { headers, body: { name: 'GA', pricePaise: 50_000 } });

    const published = await harness.request('POST', `/events/${eventId}/publish`, { headers, body: { onsale: true } });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('onsale');
  });

  it('lists only published and on-sale events, never drafts', async () => {
    const owner = randomUUID();
    const headers = await harness.as([global('organizer')], owner);
    const { eventId } = await makeEvent(owner);
    await harness.request('POST', `/events/${eventId}/tiers`, { headers, body: { name: 'GA', pricePaise: 1000 } });
    await harness.request('POST', `/events/${eventId}/publish`, { headers, body: {} });

    const draft = await makeEvent(owner);

    const listed = await harness.request('GET', '/events?limit=200');
    const ids = (listed.body.events as { event_id: string }[]).map((e) => e.event_id);
    expect(ids).toContain(eventId);
    expect(ids).not.toContain(draft.eventId);
  });

  it('a platform admin may act on any event', async () => {
    const owner = randomUUID();
    const { eventId } = await makeEvent(owner);

    const result = await harness.request('PATCH', `/events/${eventId}`, {
      headers: await harness.as([global('platform_admin')], randomUUID()),
      body: { title: 'Administratively Renamed' },
    });
    expect(result.status).toBe(200);
  });

  it('never reports seat state — that belongs to reservation (ADR-006)', async () => {
    const owner = randomUUID();
    const { eventId } = await makeEvent(owner);
    const headers = await harness.as([global('organizer')], owner);
    const tier = await harness.request('POST', `/events/${eventId}/tiers`, { headers, body: { name: 'GA', pricePaise: 1000 } });
    await harness.request('POST', `/events/${eventId}/sections`, {
      headers: await harness.as([global('platform_admin')]),
      body: { tierId: tier.body.tier_id, name: 'A', rowCount: 2, seatsPerRow: 5 },
    });

    const seatmap = await harness.request('GET', `/events/${eventId}/seatmap`);
    expect(seatmap.status).toBe(200);
    expect(seatmap.body.sections).toHaveLength(1);

    // Geometry and pricing only. No status, no hold, no availability.
    const serialized = JSON.stringify(seatmap.body);
    for (const leaked of ['available', 'held', 'sold', 'hold_id', 'held_until']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('propagates the inbound request id rather than inventing a new one', async () => {
    const requestId = randomUUID();
    const response = await fetch(`${harness.baseUrl}/healthz`, { headers: { 'x-request-id': requestId } });
    expect(response.headers.get('x-request-id')).toBe(requestId);
  });
});
