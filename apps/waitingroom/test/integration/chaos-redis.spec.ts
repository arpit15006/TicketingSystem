import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fireConcurrentRequests, countByStatus } from '@ticketing/testkit';
import { startStack, type Stack } from '../../../../test/stack.js';
import { register, seedOnSaleEvent, bearer } from '../../../../test/booking-flow.js';

/**
 * ============================================================================
 *  PRD §15.1 `chaos-redis.spec.ts` — KILL REDIS MID-SALE
 * ============================================================================
 *
 *  "Kill Redis container mid-sale → zero oversells, waiting room fails open."
 *
 *  This is the test that earns ADR-012 the right to say: Redis holds no
 *  correctness state. If Redis is completely down, the waiting room lets everyone
 *  through, seatmap reads fall back to Postgres, and seat allocation remains
 *  exactly correct.
 *
 *  The contrast with a Redis-as-source-of-truth design is the whole argument.
 */
describe('chaos: Redis dies mid-sale', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 300_000);

  afterAll(async () => {
    // Leave Redis running for whatever runs next, whatever this test did to it.
    await stack.redis.revive().catch(() => {});
    await stack.stop();
  });

  it('keeps allocating seats correctly with Redis dead, and never oversells', async () => {
    const SEATS = 50;
    const REQUESTS = 500;

    // A waiting-room event, so Redis is genuinely on this request path.
    const { eventId } = await seedOnSaleEvent(stack, SEATS, { waitingRoomEnabled: true });
    const tokens = await Promise.all(
      Array.from({ length: 25 }, async () => bearer((await register(stack)).accessToken)),
    );

    const availability = await stack.request('GET', `/availability?eventId=${eventId}&limit=${SEATS}`);
    const seatIds = (availability.body.seats as { seat_id: string }[]).map((s) => s.seat_id);
    expect(seatIds).toHaveLength(SEATS);

    // ── REDIS DIES ────────────────────────────────────────────────────────
    await stack.redis.kill();

    // The waiting room fails OPEN: no queue exists, so everyone is admitted
    // immediately with a real admission token.
    const joined = await stack.request('POST', `/queue/${eventId}/join`, {
      headers: tokens[0]!,
      baseUrl: stack.direct.waitingroom,
    });
    expect(joined.status).toBe(200);
    expect(joined.body.degraded).toBe(true);
    expect(joined.body.admitted).toBe(true);
    expect(joined.body.admissionToken).toBeDefined();

    // Seatmap reads fall back to Postgres rather than failing.
    const seatmap = await stack.request('GET', `/catalog/events/${eventId}/seatmap`);
    expect(seatmap.status).toBe(200);
    expect(seatmap.headers.get('x-cache')).toBe('miss');

    // Availability still answers, because it never touched Redis at all.
    const duringOutage = await stack.request('GET', `/availability?eventId=${eventId}&limit=5`);
    expect(duringOutage.status).toBe(200);

    // ── 500 concurrent bookings, 50 seats, Redis still dead ───────────────
    //
    // 10 contenders per seat, so the arithmetic is exact. Admission is enforced
    // for this event, and every buyer got in because the waiting room failed open.
    const admissionTokens = await Promise.all(
      tokens.map(async (token) => {
        const response = await stack.request('POST', `/queue/${eventId}/join`, {
          headers: token,
          baseUrl: stack.direct.waitingroom,
        });
        return { ...token, 'x-admission-token': response.body.admissionToken as string };
      }),
    );

    const results = await fireConcurrentRequests({
      baseUrl: stack.gatewayUrl,
      count: REQUESTS,
      build: (index) => ({
        method: 'POST',
        path: '/reservations',
        headers: admissionTokens[index % admissionTokens.length]!,
        body: { eventId, seatIds: [seatIds[index % SEATS]] },
      }),
    });

    const statuses = countByStatus(results);
    console.log('\n──────── REDIS CHAOS PROOF ────────');
    console.log(`redis               : KILLED before this burst`);
    console.log(`requests fired      : ${REQUESTS} (real parallel HTTP, through the gateway)`);
    console.log(`seats available     : ${SEATS}`);
    console.log(`status counts       : ${JSON.stringify(statuses)}`);

    // ── THE ASSERTION THAT MATTERS ────────────────────────────────────────
    expect(statuses[201]).toBe(SEATS);
    expect(statuses[409]).toBe(REQUESTS - SEATS);
    expect(Object.keys(statuses).sort()).toEqual(['201', '409']);

    const held = await stack.pools.reservation.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE event_id = $1 AND status = 'held' AND held_until > now()`,
      [eventId],
    );
    expect(Number(held.rows[0]?.count)).toBe(SEATS);

    // No seat under two holds, with Redis dead the whole time.
    const overlapping = await stack.pools.reservation.query<{ count: string }>(
      `SELECT count(*) FROM (
         SELECT unnest(seat_ids) AS seat_id FROM holds WHERE event_id = $1 AND status = 'active'
         GROUP BY 1 HAVING count(*) > 1
       ) AS d`,
      [eventId],
    );
    expect(Number(overlapping.rows[0]?.count)).toBe(0);

    const metrics = await fetch(`${stack.direct.reservation}/metrics`).then((r) => r.text());
    expect(metrics).toContain('oversell_total 0');
    console.log('oversell_total      : 0  ✅  (Redis was down for all of it)\n');

    // ── REDIS COMES BACK ──────────────────────────────────────────────────
    await stack.redis.revive();

    /*
     * The queue works again with no restart and no intervention — once the
     * service's Redis client finishes reconnecting on its own backoff schedule.
     * Polling for that is honest; asserting it is instantaneous would be testing
     * ioredis's retry timing rather than our recovery behaviour.
     */
    const deadline = Date.now() + 30_000;
    let recovered = await stack.request('POST', `/queue/${randomUUID()}/join`, {
      headers: tokens[0]!,
      baseUrl: stack.direct.waitingroom,
    });
    while (recovered.body.degraded === true && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      recovered = await stack.request('POST', `/queue/${randomUUID()}/join`, {
        headers: tokens[0]!,
        baseUrl: stack.direct.waitingroom,
      });
    }
    expect(recovered.status).toBe(200);
    expect(recovered.body.degraded).toBe(false);
  }, 300_000);

  /** Polls the seatmap until Redis is serving it, or fails with a clear message. */
  const expectCacheHitEventually = async (eventId: string, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // The TTL is short, so warm and read back-to-back.
      await stack.request('GET', `/catalog/events/${eventId}/seatmap`);
      const second = await stack.request('GET', `/catalog/events/${eventId}/seatmap`);
      if (second.headers.get('x-cache') === 'hit') return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('seatmap never served from cache within the timeout');
  };

  it('serves the seatmap from Postgres while Redis is down, and caches again after', async () => {
    const { eventId, tierId, adminToken } = await seedOnSaleEvent(stack, 5);
    await stack.request('POST', `/catalog/events/${eventId}/sections`, {
      headers: bearer(adminToken),
      body: { tierId, name: 'A', rowCount: 2, seatsPerRow: 5 },
    });

    /*
     * Warm the cache, allowing for reconnection.
     *
     * A previous test killed and revived Redis, and an ioredis client reconnects
     * on its own schedule — it can still be backing off for a second or two after
     * the server is accepting connections again. That is normal client behaviour,
     * not a defect, so the test waits for the cache to become usable rather than
     * assuming reconnection is instantaneous.
     */
    await expectCacheHitEventually(eventId);

    await stack.redis.kill();

    const degraded = await stack.request('GET', `/catalog/events/${eventId}/seatmap`);
    expect(degraded.status).toBe(200);
    expect(degraded.headers.get('x-cache')).toBe('miss');
    expect(degraded.body.sections).toHaveLength(1);

    await stack.redis.revive();

    // Caching resumes by itself once the client reconnects — no restart needed.
    await expectCacheHitEventually(eventId);
  }, 300_000);

  it('keeps authenticating and rate limiting gracefully with Redis down', async () => {
    const user = await register(stack);
    await stack.redis.kill();

    // The jti denylist lives in Redis; it fails open, so a valid token keeps
    // working. ADR-011 states that cost: up to 10 minutes of revocation staleness.
    const me = await stack.request('GET', '/identity/me', { headers: bearer(user.accessToken) });
    expect(me.status).toBe(200);

    // The rate limiter's store is gone; requests pass rather than 500.
    for (let i = 0; i < 5; i += 1) {
      const response = await stack.request('GET', '/catalog/events');
      expect(response.status).toBe(200);
    }

    await stack.redis.revive();
  }, 300_000);
});
