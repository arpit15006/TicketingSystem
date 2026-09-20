import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from '../helpers.js';

/**
 * PRD §15.1 `refresh-reuse.spec.ts` — the mandatory proof for ADR-011.
 *
 * Rotation alone is not the security property. The property is that a stolen
 * refresh token is usable *at most once* before the theft becomes detectable, and
 * that detection kills the whole chain rather than one token.
 */
describe('refresh token rotation and reuse detection', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);
  afterAll(async () => {
    await harness.stop();
  });

  it('rotates the refresh token on every use', async () => {
    const user = await harness.register();

    const first = await harness.post('/auth/refresh', { refreshToken: user.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(user.refreshToken);

    const second = await harness.post('/auth/refresh', { refreshToken: first.body.refreshToken });
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.body.refreshToken);
  });

  it('revokes the entire family when a rotated token is presented again', async () => {
    const user = await harness.register();

    // Legitimate client rotates once. The old token is now spent.
    const rotated = await harness.post('/auth/refresh', { refreshToken: user.refreshToken });
    expect(rotated.status).toBe(200);
    const currentToken = rotated.body.refreshToken as string;

    // An attacker replays the stolen (already-rotated) token.
    const reuse = await harness.post('/auth/refresh', { refreshToken: user.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');

    // The critical assertion: the legitimate client's *current* token is dead too.
    // Anything less would leave the attacker's chain alive alongside the victim's.
    const afterDetection = await harness.post('/auth/refresh', { refreshToken: currentToken });
    expect(afterDetection.status).toBe(401);

    const rows = await harness.pool.query<{ count: string }>(
      `SELECT count(*) FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.userId],
    );
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  it('only revokes the compromised family, not the user\'s other sessions', async () => {
    const user = await harness.register();

    // A second login starts an independent rotation family — a different device.
    const otherDevice = await harness.post('/auth/login', { email: user.email, password: user.password });
    expect(otherDevice.status).toBe(200);

    const rotated = await harness.post('/auth/refresh', { refreshToken: user.refreshToken });
    expect(rotated.status).toBe(200);
    const reuse = await harness.post('/auth/refresh', { refreshToken: user.refreshToken });
    expect(reuse.status).toBe(401);

    // Signing the user out of a device they still hold would be a denial of service
    // dressed up as security. The blast radius is the compromised chain only.
    const stillValid = await harness.post('/auth/refresh', { refreshToken: otherDevice.body.refreshToken });
    expect(stillValid.status).toBe(200);
  });

  it('rejects an unknown refresh token without leaking why', async () => {
    const result = await harness.post('/auth/refresh', { refreshToken: 'not-a-real-token' });
    expect(result.status).toBe(401);
    expect(result.body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('never stores the refresh token in plaintext', async () => {
    const user = await harness.register();
    const stored = await harness.pool.query<{ hash: string }>(
      `SELECT hash FROM refresh_tokens WHERE user_id = $1`,
      [user.userId],
    );
    const hash = stored.rows[0]?.hash;
    expect(hash).toBeDefined();
    expect(hash).not.toBe(user.refreshToken);
    // sha256 hex.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logging out revokes the family', async () => {
    const user = await harness.register();

    const logout = await harness.post(
      '/auth/logout',
      { refreshToken: user.refreshToken },
      { authorization: `Bearer ${user.accessToken}` },
    );
    expect(logout.status).toBe(204);

    const afterLogout = await harness.post('/auth/refresh', { refreshToken: user.refreshToken });
    expect(afterLogout.status).toBe(401);
  });
});
