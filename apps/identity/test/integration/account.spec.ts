import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from '../helpers.js';

describe('account: change password', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('rejects a wrong current password', async () => {
    const user = await harness.register();
    const attempt = await harness.post(
      '/auth/change-password',
      { currentPassword: 'not the password', newPassword: 'a brand new passphrase' },
      { authorization: `Bearer ${user.accessToken}` },
    );
    expect(attempt.status).toBe(401);
    expect(attempt.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('changes the password, revokes other sessions, and keeps this one going', async () => {
    const user = await harness.register();
    // A second session, as a phone would be.
    const phone = await harness.post('/auth/login', { email: user.email, password: user.password });
    expect(phone.status).toBe(200);

    const changed = await harness.post(
      '/auth/change-password',
      { currentPassword: user.password, newPassword: 'a brand new passphrase' },
      { authorization: `Bearer ${user.accessToken}` },
    );
    expect(changed.status).toBe(200);
    expect(typeof changed.body.accessToken).toBe('string');

    // The new credential works, the old one does not.
    expect((await harness.post('/auth/login', { email: user.email, password: 'a brand new passphrase' })).status).toBe(200);
    expect((await harness.post('/auth/login', { email: user.email, password: user.password })).status).toBe(401);

    // The phone's refresh token is dead; the pair issued by the change is live.
    expect((await harness.post('/auth/refresh', { refreshToken: phone.body.refreshToken })).status).toBe(401);
    expect((await harness.post('/auth/refresh', { refreshToken: changed.body.refreshToken })).status).toBe(200);
  });

  it('looks a user up by email for another service, and only for another service', async () => {
    const user = await harness.register();
    const anonymous = await harness.get(`/internal/users/by-email?email=${encodeURIComponent(user.email)}`);
    expect(anonymous.status).toBe(401);

    const found = await harness.get(`/internal/users/by-email?email=${encodeURIComponent(user.email)}`, harness.serviceHeaders);
    expect(found.status).toBe(200);
    expect(found.body.userId).toBe(user.userId);

    const missing = await harness.get('/internal/users/by-email?email=nobody@example.com', harness.serviceHeaders);
    expect(missing.status).toBe(404);
  });
});
