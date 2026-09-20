import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startStack, type Stack } from '../../../../test/stack.js';
import { loadConfig as loadGatewayConfig } from '../../src/config.js';
import { buildServer as buildGateway } from '../../src/server.js';

const run = promisify(execFile);
const SEED_SCRIPT = fileURLToPath(new URL('../../../../scripts/seed.ts', import.meta.url));

describe('seed script and gateway rate limiting', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 240_000);

  afterAll(async () => {
    await stack.stop();
  });

  /** PRD §17 — the real `pnpm seed` deliverable, executed as a subprocess. */
  it('seeds a demo organizer, a venue and an on-sale event with 5,000 seats', async () => {
    const { stdout } = await run('node', [SEED_SCRIPT], {
      env: {
        ...process.env,
        GATEWAY_URL: stack.gatewayUrl,
        BOOTSTRAP_ADMIN_EMAIL: stack.bootstrapAdminEmail,
      },
      timeout: 180_000,
    });

    expect(stdout).toContain('seed complete');

    // The load test and the runbook depend on this exact event keeping 5,000 seats.
    const demo = await stack.pools.catalog.query<{ event_id: string; status: string }>(
      `SELECT event_id, status FROM events WHERE title = 'Demo On-Sale Event'`,
    );
    expect(demo.rows).toHaveLength(1);
    expect(demo.rows[0]?.status).toBe('onsale');
    const demoSeats = await stack.pools.reservation.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE event_id = $1`,
      [demo.rows[0]?.event_id],
    );
    expect(Number(demoSeats.rows[0]?.count)).toBe(5000);

    // Every provisioned seat starts available; nothing is pre-sold or pre-held.
    const seats = await stack.pools.reservation.query<{ total: string; available: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'available') AS available FROM seats`,
    );
    expect(seats.rows[0]?.available).toBe(seats.rows[0]?.total);
    expect(Number(seats.rows[0]?.total)).toBeGreaterThan(5000);

    // One draft, and it has no inventory: a draft is not for sale.
    const byStatus = await stack.pools.catalog.query<{ status: string; count: string }>(
      `SELECT status, count(*) FROM events GROUP BY status`,
    );
    const counts = Object.fromEntries(byStatus.rows.map((r) => [r.status, Number(r.count)]));
    expect(counts['draft']).toBe(1);
    expect(counts['published']).toBe(1);
    expect(counts['onsale']).toBe(6);

    /*
     * The plain organizer's events exist. organizer2@demo.test holds only the
     * global organizer and venue_admin roles — so this proves the grant chain
     * (catalog → identity, over service auth) works through the real gateway,
     * with no admin involved in creating the venue, the event, or its seats.
     */
    const sunburn = await stack.pools.catalog.query<{ organizer_id: string }>(
      `SELECT organizer_id FROM events WHERE title LIKE 'Sunburn%'`,
    );
    const organizer2 = await stack.pools.identity.query<{ user_id: string }>(
      `SELECT user_id FROM users WHERE email = 'organizer2@demo.test'`,
    );
    expect(sunburn.rows[0]?.organizer_id).toBe(organizer2.rows[0]?.user_id);
    const grants = await stack.pools.identity.query<{ role: string; resource_type: string | null }>(
      `SELECT role, resource_type FROM role_assignments WHERE user_id = $1 ORDER BY role, resource_type`,
      [organizer2.rows[0]?.user_id],
    );
    expect(grants.rows).toContainEqual({ role: 'organizer', resource_type: 'event' });
    expect(grants.rows).toContainEqual({ role: 'venue_admin', resource_type: 'venue' });
    expect(grants.rows.some((g) => g.role === 'platform_admin')).toBe(false);

    // The scanner is hired per event (PRD §9.2), never globally.
    const scanner = await stack.pools.identity.query<{ count: string }>(
      `SELECT count(*) FROM role_assignments r JOIN users u ON u.user_id = r.user_id
       WHERE u.email = 'scanner@demo.test' AND r.role = 'scanner' AND r.resource_type = 'event'`,
    );
    expect(Number(scanner.rows[0]?.count)).toBe(7);
  }, 240_000);

  it('re-running the seed is harmless', async () => {
    const before = await stack.pools.reservation.query<{ count: string }>(`SELECT count(*) FROM seats`);
    const eventsBefore = await stack.pools.catalog.query<{ count: string }>(`SELECT count(*) FROM events`);

    const { stdout } = await run('node', [SEED_SCRIPT], {
      env: { ...process.env, GATEWAY_URL: stack.gatewayUrl, BOOTSTRAP_ADMIN_EMAIL: stack.bootstrapAdminEmail },
      timeout: 180_000,
    });
    expect(stdout).toContain('user exists');
    expect(stdout).toContain('event exists');
    expect(stdout).not.toContain('event created');

    // A second run must not double anything.
    const after = await stack.pools.reservation.query<{ count: string }>(`SELECT count(*) FROM seats`);
    const eventsAfter = await stack.pools.catalog.query<{ count: string }>(`SELECT count(*) FROM events`);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect(eventsAfter.rows[0]?.count).toBe(eventsBefore.rows[0]?.count);
  }, 240_000);

  it('rate limits at the edge and says when to retry', async () => {
    // A gateway of its own, so the limit under test cannot affect other suites.
    const limited = await buildGateway({
      config: loadGatewayConfig({
        nodeEnv: 'test',
        logLevel: 'silent',
        identityUrl: stack.direct.identity,
        catalogUrl: stack.direct.catalog,
        reservationUrl: stack.direct.reservation,
        ...stack.jwt,
        rateLimitMax: 5,
        rateLimitWindowMs: 60_000,
      }),
    });

    try {
      await limited.listen({ port: 0, host: '127.0.0.1' });
      const address = limited.server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const response = await fetch(`${baseUrl}/catalog/events`);
        statuses.push(response.status);
      }

      expect(statuses.filter((s) => s === 200)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(3);

      const rejected = await fetch(`${baseUrl}/catalog/events`);
      expect(rejected.status).toBe(429);
      // A 429 without retry guidance just invites an immediate retry.
      expect(rejected.headers.get('retry-after')).not.toBeNull();
    } finally {
      await limited.close();
    }
  }, 120_000);
});
