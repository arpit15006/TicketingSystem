import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, global, type Harness } from '../helpers.js';

describe('assigning scanners, and listing venues', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  const makeEvent = async (organizerId: string) => {
    const venue = await harness.request('POST', '/venues', {
      headers: await harness.as([global('venue_admin')]),
      body: { name: `Venue ${randomUUID().slice(0, 6)}`, address: '1 Road', city: 'Surat' },
    });
    const event = await harness.request('POST', '/events', {
      headers: await harness.as([global('organizer')], organizerId),
      body: { venueId: venue.body.venue_id, title: 'Scanned Show', startsAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    return event.body.event_id as string;
  };

  it('lets the organizer assign a scanner by email, as an event-scoped grant', async () => {
    const organizerId = randomUUID();
    const eventId = await makeEvent(organizerId);
    harness.users.set('gate@example.com', { userId: randomUUID(), email: 'gate@example.com', fullName: 'Gate Keeper' });

    const assigned = await harness.request('POST', `/events/${eventId}/scanners`, {
      headers: await harness.as([global('organizer')], organizerId),
      body: { email: 'gate@example.com' },
    });

    expect(assigned.status).toBe(201);
    expect(harness.grants.at(-1)).toEqual({
      userId: harness.users.get('gate@example.com')?.userId,
      role: 'scanner',
      resourceType: 'event',
      resourceId: eventId,
    });
  });

  it('refuses a different organizer, and an unknown email', async () => {
    const eventId = await makeEvent(randomUUID());
    harness.users.set('gate2@example.com', { userId: randomUUID(), email: 'gate2@example.com', fullName: 'Gate' });

    const stranger = await harness.request('POST', `/events/${eventId}/scanners`, {
      headers: await harness.as([global('organizer')], randomUUID()),
      body: { email: 'gate2@example.com' },
    });
    expect(stranger.status).toBe(403);

    const owner = randomUUID();
    const own = await makeEvent(owner);
    const unknown = await harness.request('POST', `/events/${own}/scanners`, {
      headers: await harness.as([global('organizer')], owner),
      body: { email: 'nobody@example.com' },
    });
    expect(unknown.status).toBe(404);
  });

  it('lists venues publicly, ordered by city then name', async () => {
    await harness.request('POST', '/venues', {
      headers: await harness.as([global('venue_admin')]),
      body: { name: 'Zeta Hall', address: '1', city: 'Agra' },
    });
    const listed = await harness.request('GET', '/venues');
    expect(listed.status).toBe(200);
    const venues = listed.body.venues as { name: string; city: string }[];
    expect(venues.length).toBeGreaterThan(1);
    const keys = venues.map((v) => `${v.city}|${v.name}`);
    expect([...keys].sort()).toEqual(keys);
  });
});
