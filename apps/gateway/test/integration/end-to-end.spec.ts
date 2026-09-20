import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startStack, makePlatformAdmin, type Stack } from '../stack.js';

/**
 * PRD §16 Phase 2 acceptance — **an authenticated end-to-end seat hold through the
 * gateway**, across four services and three databases, with real RS256 verification
 * at every hop.
 */
describe('end-to-end: authenticated booking through the gateway', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 240_000);

  afterAll(async () => {
    await stack.stop();
  });

  const register = async (): Promise<{ userId: string; accessToken: string; refreshToken: string; email: string; password: string }> => {
    const email = `e2e.${randomUUID()}@example.com`;
    const password = 'correct horse battery staple';
    const result = await stack.request('POST', '/identity/auth/register', {
      body: { email, password, fullName: 'E2E User' },
    });
    expect(result.status).toBe(201);
    return { ...result.body, email, password };
  };

  const login = async (email: string, password: string): Promise<string> => {
    const result = await stack.request('POST', '/identity/auth/login', { body: { email, password } });
    expect(result.status).toBe(200);
    return result.body.accessToken as string;
  };

  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  it('runs the whole flow: register → create event → provision seats → hold a seat', async () => {
    // ── 1. A user registers through the gateway ────────────────────────────
    const organizer = await register();

    // ── 2. Promote them so they can create a venue and an event ────────────
    await makePlatformAdmin(stack.pools.identity, organizer.userId);
    const adminToken = await login(organizer.email, organizer.password);

    // ── 3. Venue and event, via catalog, through the gateway ───────────────
    const venue = await stack.request('POST', '/catalog/venues', {
      headers: bearer(adminToken),
      body: { name: 'Wankhede', address: 'Churchgate', city: 'Mumbai' },
    });
    expect(venue.status).toBe(201);

    const event = await stack.request('POST', '/catalog/events', {
      headers: bearer(adminToken),
      body: {
        venueId: venue.body.venue_id,
        title: 'Phase 2 Acceptance Concert',
        startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
    });
    expect(event.status).toBe(201);
    const eventId = event.body.event_id as string;

    const tier = await stack.request('POST', `/catalog/events/${eventId}/tiers`, {
      headers: bearer(adminToken),
      body: { name: 'Gold', pricePaise: 150_000 },
    });
    expect(tier.status).toBe(201);
    const tierId = tier.body.tier_id as string;

    await stack.request('POST', `/catalog/events/${eventId}/sections`, {
      headers: bearer(adminToken),
      body: { tierId, name: 'A', rowCount: 5, seatsPerRow: 10 },
    });

    const published = await stack.request('POST', `/catalog/events/${eventId}/publish`, {
      headers: bearer(adminToken),
      body: { onsale: true },
    });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('onsale');

    // ── 4. Seats are provisioned in reservation, which alone owns seat state ──
    const seats = await stack.request('POST', `/inventory/${eventId}/seats`, {
      headers: bearer(adminToken),
      body: { sections: [{ name: 'A', tierId, rowCount: 5, seatsPerRow: 10 }] },
    });
    expect(seats.status).toBe(201);
    expect(seats.body.totalSeats).toBe(50);

    // ── 5. An ordinary attendee browses and holds a seat ───────────────────
    const attendee = await register();

    const listed = await stack.request('GET', '/catalog/events');
    expect((listed.body.events as { event_id: string }[]).map((e) => e.event_id)).toContain(eventId);

    const availability = await stack.request('GET', `/availability?eventId=${eventId}&limit=5`);
    expect(availability.status).toBe(200);
    expect(availability.body.available).toBe(5);
    const seatId = availability.body.seats[0].seat_id as string;

    const hold = await stack.request('POST', '/reservations', {
      headers: { ...bearer(attendee.accessToken), 'idempotency-key': randomUUID() },
      body: { eventId, seatIds: [seatId] },
    });
    expect(hold.status).toBe(201);
    expect(hold.body.seatIds).toEqual([seatId]);
    expect(new Date(hold.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // ── 6. The seat is really held, in reservation's own database ──────────
    const stored = await stack.pools.reservation.query<{ status: string; hold_id: string }>(
      `SELECT status, hold_id FROM seats WHERE seat_id = $1`,
      [seatId],
    );
    expect(stored.rows[0]?.status).toBe('held');
    expect(stored.rows[0]?.hold_id).toBe(hold.body.holdId);

    // ── 7. A second attendee loses the race for the same seat ──────────────
    const rival = await register();
    const rivalAttempt = await stack.request('POST', '/reservations', {
      headers: bearer(rival.accessToken),
      body: { eventId, seatIds: [seatId] },
    });
    expect(rivalAttempt.status).toBe(409);

    // ── 8. Releasing returns it to the market ──────────────────────────────
    const released = await stack.request('DELETE', `/reservations/${hold.body.holdId}`, {
      headers: bearer(attendee.accessToken),
    });
    expect(released.status).toBe(200);

    const rivalRetry = await stack.request('POST', '/reservations', {
      headers: bearer(rival.accessToken),
      body: { eventId, seatIds: [seatId] },
    });
    expect(rivalRetry.status).toBe(201);
  }, 240_000);

  it('refuses an unauthenticated booking at the service, not just the edge', async () => {
    const anonymous = await stack.request('POST', '/reservations', {
      body: { eventId: randomUUID(), seatIds: [randomUUID()] },
    });
    expect(anonymous.status).toBe(401);

    // ADR-010 — bypass the gateway entirely and the service still refuses. A
    // service that relied on the edge would be wide open on its internal port.
    const direct = await stack.request('POST', '/reservations', {
      baseUrl: stack.direct.reservation,
      body: { eventId: randomUUID(), seatIds: [randomUUID()] },
    });
    expect(direct.status).toBe(401);
  });

  it('a forged role header buys nothing, because no service reads one', async () => {
    const attendee = await register();
    const eventId = randomUUID();

    // The classic attack on a gateway-trusts-header design.
    const forged = await stack.request('POST', `/inventory/${eventId}/seats`, {
      headers: {
        ...bearer(attendee.accessToken),
        'x-user-roles': 'platform_admin',
        'x-user-id': randomUUID(),
        'x-dev-user-id': randomUUID(),
      },
      body: { sections: [{ name: 'A', tierId: randomUUID(), rowCount: 1, seatsPerRow: 1 }] },
    });
    // Authorization came from the signed token's claims, which say "attendee".
    expect(forged.status).toBe(403);
  });

  it('rejects an invalid token at the edge before it reaches a service', async () => {
    const result = await stack.request('GET', '/catalog/events', {
      headers: { authorization: 'Bearer not.a.token' },
    });
    expect(result.status).toBe(401);
  });

  it('propagates one requestId from the edge through to the service', async () => {
    const requestId = randomUUID();

    const response = await stack.request('GET', '/catalog/events', { headers: { 'x-request-id': requestId } });
    expect(response.status).toBe(200);
    // PRD §14 — the same id comes back, which is what makes the log grep work.
    expect(response.headers.get('x-request-id')).toBe(requestId);

    // And when the client sends none, the gateway mints one.
    const minted = await stack.request('GET', '/catalog/events');
    const generated = minted.headers.get('x-request-id');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refresh rotation works through the gateway', async () => {
    const user = await register();

    const refreshed = await stack.request('POST', '/identity/auth/refresh', {
      body: { refreshToken: user.refreshToken },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(user.refreshToken);

    const reuse = await stack.request('POST', '/identity/auth/refresh', {
      body: { refreshToken: user.refreshToken },
    });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');
  });

  it('serves JWKS through the gateway so any client can verify tokens', async () => {
    const jwks = await stack.request('GET', '/identity/.well-known/jwks.json');
    expect(jwks.status).toBe(200);
    expect(jwks.body.keys[0].kty).toBe('RSA');
    expect(jwks.body.keys[0].d).toBeUndefined();
  });
});
