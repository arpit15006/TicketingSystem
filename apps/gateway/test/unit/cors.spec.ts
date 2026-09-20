import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { buildServer, type GatewayServer } from '../../src/server.js';

/**
 * PRD §13 — "the client talks only to the gateway", which makes this file the whole
 * CORS surface of the platform.
 *
 * No upstream is ever reached here: a preflight is answered by the edge itself, so
 * the proxy targets below are deliberately unreachable. What is being pinned down
 * is the *order* of the edge's hooks, and the exact header allowlist the browser
 * is told about — both of which are silent failures when wrong. A missing
 * `idempotency-key` in `allowedHeaders` does not error anywhere; it just means the
 * browser quietly drops the one header that makes a double-tapped checkout safe.
 */
describe('gateway CORS', () => {
  let app: GatewayServer;

  const ALLOWED = 'http://localhost:3007';

  beforeAll(async () => {
    app = await buildServer({
      config: loadConfig({
        corsOrigins: [ALLOWED],
        redisUrl: '',
        logLevel: 'silent',
        // Deliberately low: the preflight-quota test below depends on it.
        rateLimitMax: 3,
        rateLimitWindowMs: 60_000,
      }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const preflight = async (origin: string, headers = 'authorization,content-type') =>
    app.inject({
      method: 'OPTIONS',
      url: '/catalog/events',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': headers,
      },
    });

  it('answers a preflight from an allowed origin', async () => {
    const response = await preflight(ALLOWED);

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(String(response.headers['access-control-allow-methods'])).toContain('POST');
  });

  it('allows every header a client legitimately sends', async () => {
    const response = await preflight(ALLOWED);
    const allowed = String(response.headers['access-control-allow-headers']).toLowerCase();

    // Each of these is read by some service; omitting one disables that mechanism
    // in the browser and nowhere else, which is the worst way for it to break.
    expect(allowed).toContain('authorization');
    expect(allowed).toContain('content-type');
    // Duplicate-request protection (PRD §8.1).
    expect(allowed).toContain('idempotency-key');
    // Waiting-room admission (PRD §12).
    expect(allowed).toContain('x-admission-token');
    // SSE reconnection (ADR-016).
    expect(allowed).toContain('last-event-id');
  });

  it('exposes the request id so a browser can quote it in a bug report', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: ALLOWED } });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    // PRD §14 — the id is useless to a user if the browser cannot read it.
    expect(String(response.headers['access-control-expose-headers']).toLowerCase()).toContain('x-request-id');
  });

  it('does not grant an origin that is not on the allowlist', async () => {
    const response = await preflight('https://evil.example');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  /**
   * The reason CORS is registered before the rate limiter.
   *
   * A preflight is the browser asking permission; it can never book a seat. If it
   * spent quota, a burst of them would make the edge answer "429" to the question
   * "may I send you a request?" — and the browser would report a CORS failure, not
   * a rate limit, which is close to undebuggable from a bug report.
   */
  it('does not spend rate-limit quota on preflights', async () => {
    const config = loadConfig({ corsOrigins: [ALLOWED], redisUrl: '', logLevel: 'silent', rateLimitMax: 3, rateLimitWindowMs: 60_000 });
    const isolated = await buildServer({ config });
    await isolated.ready();

    try {
      for (let i = 0; i < 10; i += 1) {
        const response = await isolated.inject({
          method: 'OPTIONS',
          url: '/catalog/events',
          headers: { origin: ALLOWED, 'access-control-request-method': 'POST' },
        });
        expect(response.statusCode).toBe(204);
      }

      // Ten preflights later, the budget of three real requests is untouched.
      const real = await isolated.inject({ method: 'GET', url: '/healthz', headers: { origin: ALLOWED } });
      expect(real.statusCode).toBe(200);
    } finally {
      await isolated.close();
    }
  });

  it('still rate limits real requests', async () => {
    const config = loadConfig({ corsOrigins: [ALLOWED], redisUrl: '', logLevel: 'silent', rateLimitMax: 3, rateLimitWindowMs: 60_000 });
    const isolated = await buildServer({ config });
    await isolated.ready();

    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        codes.push((await isolated.inject({ method: 'GET', url: '/healthz' })).statusCode);
      }
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    } finally {
      await isolated.close();
    }
  });
});
