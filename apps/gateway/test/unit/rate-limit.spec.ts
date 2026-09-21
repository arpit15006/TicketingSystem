import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer, RATE_LIMIT_BYPASS_HEADER } from '../../src/server.js';

/**
 * The rate limit is edge behaviour and protects no invariant (ADR-012). Its one
 * exemption exists for the concurrency demo's load generator, which is supposed
 * to look like a thundering herd.
 *
 * The exemption is a secret, not an address, and these tests pin down why: behind
 * a bridge or a proxy the generator and every browser share one IP, so an IP
 * allowlist would lift the limit for real users. Raising RATE_LIMIT_MAX globally
 * — the thing this replaces — has the same fault.
 */
describe('gateway rate limit', () => {
  const build = async (overrides: { rateLimitBypassToken?: string } = {}) => {
    const app = await buildServer({
      config: loadConfig({
        redisUrl: '',
        logLevel: 'silent',
        rateLimitMax: 3,
        rateLimitWindowMs: 60_000,
        rateLimitBypassToken: overrides.rateLimitBypassToken ?? '',
      }),
    });
    await app.ready();
    return app;
  };

  const hammer = async (
    app: Awaited<ReturnType<typeof build>>,
    count: number,
    headers: Record<string, string> = {},
  ): Promise<number[]> => {
    const codes: number[] = [];
    for (let i = 0; i < count; i += 1) {
      codes.push((await app.inject({ method: 'GET', url: '/healthz', headers })).statusCode);
    }
    return codes;
  };

  it('limits ordinary traffic', async () => {
    const app = await build();
    try {
      const codes = await hammer(app, 6);
      expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
      expect(codes.filter((c) => c === 429).length).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('exempts a caller presenting the configured token', async () => {
    const app = await build({ rateLimitBypassToken: 'load-generator-secret' });
    try {
      const codes = await hammer(app, 20, { [RATE_LIMIT_BYPASS_HEADER]: 'load-generator-secret' });
      expect(codes.every((c) => c === 200)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('still limits everyone else while a token is configured', async () => {
    const app = await build({ rateLimitBypassToken: 'load-generator-secret' });
    try {
      // The exemption is per-request, so a browser sharing the generator's IP is
      // limited exactly as before.
      const codes = await hammer(app, 6);
      expect(codes.filter((c) => c === 429).length).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('refuses a wrong token, and a token when none is configured', async () => {
    const configured = await build({ rateLimitBypassToken: 'load-generator-secret' });
    try {
      const wrong = await hammer(configured, 6, { [RATE_LIMIT_BYPASS_HEADER]: 'guessed-it' });
      expect(wrong.filter((c) => c === 429).length).toBe(3);
    } finally {
      await configured.close();
    }

    // Unset is the default and the production setting: there is no bypass to present.
    const disabled = await build();
    try {
      const codes = await hammer(disabled, 6, { [RATE_LIMIT_BYPASS_HEADER]: '' });
      expect(codes.filter((c) => c === 429).length).toBe(3);
    } finally {
      await disabled.close();
    }
  });
});
