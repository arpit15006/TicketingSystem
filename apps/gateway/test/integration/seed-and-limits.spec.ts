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
    expect(stdout).toContain('seats     : 5000');

    const seats = await stack.pools.reservation.query<{ count: string }>(`SELECT count(*) FROM seats`);
    expect(Number(seats.rows[0]?.count)).toBe(5000);

    const available = await stack.pools.reservation.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE status = 'available'`,
    );
    expect(Number(available.rows[0]?.count)).toBe(5000);

    const onsale = await stack.pools.catalog.query<{ status: string }>(`SELECT status FROM events`);
    expect(onsale.rows[0]?.status).toBe('onsale');

    // Two tiers across two sections, and catalog holds the geometry only.
    const sections = await stack.pools.catalog.query<{ count: string }>(`SELECT count(*) FROM seatmap_sections`);
    expect(Number(sections.rows[0]?.count)).toBe(2);
  }, 240_000);

  it('re-running the seed is harmless', async () => {
    const { stdout } = await run('node', [SEED_SCRIPT], {
      env: { ...process.env, GATEWAY_URL: stack.gatewayUrl, BOOTSTRAP_ADMIN_EMAIL: stack.bootstrapAdminEmail },
      timeout: 180_000,
    });
    expect(stdout).toContain('already existed');

    // A second run must not double the inventory.
    const seats = await stack.pools.reservation.query<{ count: string }>(`SELECT count(*) FROM seats`);
    expect(Number(seats.rows[0]?.count)).toBe(5000);
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
