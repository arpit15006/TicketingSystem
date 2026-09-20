import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { createPool } from '@ticketing/http';
import { createTestDatabase, startTestIdentity, type TestDatabase, type TestIdentity } from '@ticketing/testkit';
import type { Pool } from 'pg';
import { loadConfig } from '../../src/config.js';
import { buildServer, type NotificationServer } from '../../src/server.js';
import { NOTIFICATION_MIGRATIONS } from '../helpers.js';

/**
 * ADR-010 — a notification belongs to the user it was written for.
 *
 * Before this, GET /notifications took `userId` as a query parameter and no
 * token: anyone could read anyone's order confirmations. The filter is now the
 * verified subject of the bearer token, so there is no request that names
 * another user.
 */
describe('GET /notifications is scoped to the caller', () => {
  let db: TestDatabase;
  let identity: TestIdentity;
  let pool: Pool;
  let app: NotificationServer;
  let baseUrl: string;

  beforeAll(async () => {
    db = await createTestDatabase({ adminUrl: inject('pgAdminUrl'), migrationsDir: NOTIFICATION_MIGRATIONS });
    identity = await startTestIdentity();
    pool = createPool({ databaseUrl: db.url, max: 5 });
    app = await buildServer({
      config: loadConfig({
        databaseUrl: db.url,
        nodeEnv: 'test',
        logLevel: 'silent',
        jwksUri: identity.jwksUri,
        jwtIssuer: identity.issuer,
        jwtAudience: identity.audience,
      }),
      pool,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
    await db.drop();
    await identity.stop();
  });

  const seed = async (userId: string, subject: string): Promise<void> => {
    const eventId = `test-${randomUUID()}`;
    await pool.query(`INSERT INTO processed_events (event_id, event_type) VALUES ($1, 'ticketing.order.confirmed')`, [eventId]);
    await pool.query(
      `INSERT INTO notifications (event_id, user_id, kind, subject, body, payload) VALUES ($1, $2, 'order_confirmed', $3, 'body', '{}')`,
      [eventId, userId, subject],
    );
  };

  it('requires a token', async () => {
    const response = await fetch(`${baseUrl}/notifications`);
    expect(response.status).toBe(401);
  });

  it('returns only the caller\'s rows, ignoring any userId in the query', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    await seed(alice, 'alice order');
    await seed(bob, 'bob order');

    const asAlice = await fetch(`${baseUrl}/notifications?userId=${bob}`, { headers: await identity.attendee(alice) });
    expect(asAlice.status).toBe(200);
    const body = (await asAlice.json()) as { notifications: { subject: string }[] };
    expect(body.notifications.map((n) => n.subject)).toEqual(['alice order']);
  });
});
