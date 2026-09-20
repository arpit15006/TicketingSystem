import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from '../helpers.js';

/**
 * The service-to-service grant route catalog uses after creating an event or a
 * venue. It is guarded by the shared service token, and it is deliberately
 * narrower than the admin route: a service token must never be able to mint
 * `platform_admin`.
 */
describe('internal role grants', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('requires the service token', async () => {
    const user = await harness.register();
    const attempt = await harness.post(`/internal/users/${user.userId}/roles`, {
      role: 'organizer', resourceType: 'event', resourceId: randomUUID(),
    });
    expect(attempt.status).toBe(401);
  });

  it('records a scoped grant that appears in the next token', async () => {
    const user = await harness.register();
    const eventId = randomUUID();

    const granted = await harness.post(
      `/internal/users/${user.userId}/roles`,
      { role: 'organizer', resourceType: 'event', resourceId: eventId },
      harness.serviceHeaders,
    );
    expect(granted.status).toBe(201);

    // Grants are read at token issue time (PRD §9.1), so a fresh login carries it.
    const login = await harness.post('/auth/login', { email: user.email, password: user.password });
    const me = await harness.get('/me', { authorization: `Bearer ${login.body.accessToken}` });
    expect(me.body.roles).toContainEqual({ role: 'organizer', resourceType: 'event', resourceId: eventId });
  });

  it('cannot mint platform_admin, and cannot mint a global role', async () => {
    const user = await harness.register();

    const admin = await harness.post(
      `/internal/users/${user.userId}/roles`,
      { role: 'platform_admin', resourceType: 'event', resourceId: randomUUID() },
      harness.serviceHeaders,
    );
    expect(admin.status).toBe(400);

    // No resource → refused by the schema; the route only issues scoped grants.
    const unscoped = await harness.post(`/internal/users/${user.userId}/roles`, { role: 'organizer' }, harness.serviceHeaders);
    expect(unscoped.status).toBe(400);
  });
});
