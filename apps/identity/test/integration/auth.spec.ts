import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { startHarness, type Harness } from '../helpers.js';

describe('registration, login and tokens', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);
  afterAll(async () => {
    await harness.stop();
  });

  it('registers a user, hashes with argon2id, and grants the attendee role', async () => {
    const user = await harness.register();
    expect(user.userId).toMatch(/^[0-9a-f-]{36}$/);

    const stored = await harness.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE user_id = $1`,
      [user.userId],
    );
    const hash = stored.rows[0]?.password_hash ?? '';
    // Turns the ARGON2ID = 2 literal in passwords.ts into a checked fact.
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain(user.password);

    const roles = await harness.pool.query<{ role: string; resource_type: string | null }>(
      `SELECT role, resource_type FROM role_assignments WHERE user_id = $1`,
      [user.userId],
    );
    expect(roles.rows).toEqual([{ role: 'attendee', resource_type: null }]);
  });

  it('issues an RS256 access token with the claims PRD §9.1 specifies', async () => {
    const user = await harness.register();

    const header = decodeProtectedHeader(user.accessToken);
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBeDefined();

    const claims = decodeJwt(user.accessToken);
    expect(claims.sub).toBe(user.userId);
    expect(claims.jti).toBeDefined();
    expect(claims.iat).toBeDefined();
    expect(claims.roles).toEqual(['attendee']);

    // PRD §9.1 — 10 minute TTL. Short life is what bounds a stolen token's value.
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(600);
  });

  it('treats email case-insensitively and refuses a duplicate registration', async () => {
    const user = await harness.register();

    const duplicate = await harness.post('/auth/register', {
      email: user.email.toUpperCase(),
      password: 'another passphrase here',
      fullName: 'Impostor',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('logs in with the right password and rejects the wrong one identically to an unknown user', async () => {
    const user = await harness.register();

    const good = await harness.post('/auth/login', { email: user.email, password: user.password });
    expect(good.status).toBe(200);
    expect(good.body.accessToken).toBeDefined();

    const wrongPassword = await harness.post('/auth/login', { email: user.email, password: 'wrong wrong wrong' });
    const unknownUser = await harness.post('/auth/login', { email: 'nobody@example.com', password: 'wrong wrong wrong' });

    // Identical responses: anything else is an account-enumeration oracle.
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.code).toBe(unknownUser.body.code);
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
  });

  it('rejects a weak password at the schema boundary', async () => {
    const result = await harness.post('/auth/register', {
      email: `weak.${Date.now()}@example.com`,
      password: 'short',
      fullName: 'Test',
    });
    expect(result.status).toBe(400);
  });

  it('serves a JWKS containing only the public half of the key', async () => {
    const jwks = await harness.get('/.well-known/jwks.json');
    expect(jwks.status).toBe(200);
    expect(jwks.body.keys).toHaveLength(1);

    const key = jwks.body.keys[0];
    expect(key.kty).toBe('RSA');
    expect(key.alg).toBe('RS256');
    expect(key.kid).toBeDefined();
    expect(key.n).toBeDefined();
    expect(key.e).toBeDefined();
    // The private exponent and primes must never be published.
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(key[secret]).toBeUndefined();
    }
  });

  it('serves /me only to an authenticated caller', async () => {
    const user = await harness.register();

    const anonymous = await harness.get('/me');
    expect(anonymous.status).toBe(401);

    const authenticated = await harness.get('/me', { authorization: `Bearer ${user.accessToken}` });
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.userId).toBe(user.userId);
    expect(authenticated.body.roles).toEqual([{ role: 'attendee', resourceType: null, resourceId: null }]);
  });

  it('rejects a tampered token', async () => {
    const user = await harness.register();
    const [header, payload, signature] = user.accessToken.split('.');
    // Flip the signature: the claims are unchanged, so only verification can catch it.
    const forged = `${header}.${payload}.${signature!.slice(0, -4)}AAAA`;

    const result = await harness.get('/me', { authorization: `Bearer ${forged}` });
    expect(result.status).toBe(401);
  });

  it('refuses to grant roles to a caller who is not a platform admin', async () => {
    const user = await harness.register();
    const victim = await harness.register();

    const attempt = await harness.post(
      `/users/${victim.userId}/roles`,
      { role: 'platform_admin' },
      { authorization: `Bearer ${user.accessToken}` },
    );
    // An attendee holds no grant for event:create, so the check fails before the
    // platform-admin test is even reached.
    expect(attempt.status).toBe(403);
  });

  it('lets a platform admin grant a resource-scoped role', async () => {
    const admin = await harness.register();
    const organizer = await harness.register();
    const eventId = '33333333-3333-3333-3333-333333333333';

    await harness.pool.query(`INSERT INTO role_assignments (user_id, role) VALUES ($1, 'platform_admin')`, [admin.userId]);
    const relogin = await harness.post('/auth/login', { email: admin.email, password: admin.password });

    const granted = await harness.post(
      `/users/${organizer.userId}/roles`,
      { role: 'organizer', resourceType: 'event', resourceId: eventId },
      { authorization: `Bearer ${relogin.body.accessToken}` },
    );
    expect(granted.status).toBe(201);

    const organizerLogin = await harness.post('/auth/login', { email: organizer.email, password: organizer.password });
    const claims = decodeJwt(organizerLogin.body.accessToken as string);
    // The grant travels in the token in its scoped form, so a service can enforce
    // it without calling back to identity on every request.
    expect(claims.roles).toContain(`organizer:event:${eventId}`);
  });
});

/**
 * Regression for a boot-time crash found by `docker compose up`: Compose
 * substitutes an unset `${VAR:-}` as an empty string, and treating that as
 * "configured" sent an empty key to jose and killed the service on startup.
 */
describe('configuration robustness', () => {
  it('treats an empty key environment variable as absent, not as an empty key', async () => {
    const { loadConfig } = await import('../../src/config.js');
    const { loadSigningKeys } = await import('../../src/keys.js');

    const previous = { ...process.env };
    process.env['JWT_PRIVATE_KEY'] = '';
    process.env['JWT_PUBLIC_KEY'] = '';
    process.env['JWT_KEY_ID'] = '';

    try {
      const config = loadConfig({ databaseUrl: 'postgresql://unused/unused', nodeEnv: 'test' });
      expect(config.privateKeyPem).toBeUndefined();
      // Falls back to a generated development keypair rather than crashing.
      const keys = await loadSigningKeys(config);
      expect(keys.jwks.keys).toHaveLength(1);
    } finally {
      process.env = previous;
    }
  });
});
