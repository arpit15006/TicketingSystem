import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { createPool } from '@ticketing/http';
import { createTestDatabase, type TestDatabase } from '@ticketing/testkit';

import { loadConfig as loadIdentityConfig } from '../apps/identity/src/config.js';
import { loadSigningKeys } from '../apps/identity/src/keys.js';
import { createInMemoryDenylist } from '../apps/identity/src/denylist.js';
import { buildServer as buildIdentity } from '../apps/identity/src/server.js';

import { loadConfig as loadCatalogConfig } from '../apps/catalog/src/config.js';
import { buildServer as buildCatalog } from '../apps/catalog/src/server.js';

import { loadConfig as loadReservationConfig } from '../apps/reservation/src/config.js';
import { buildServer as buildReservation } from '../apps/reservation/src/server.js';

import { loadConfig as loadOrdersConfig } from '../apps/orders/src/config.js';
import { buildServer as buildOrders } from '../apps/orders/src/server.js';
import { createRazorpayClient } from '../apps/orders/src/razorpay.js';
import { createReservationClient, createCatalogClient } from '../apps/orders/src/clients.js';
import { startFakeRazorpay, startRedis, type FakeRazorpay, type TestRedis } from '@ticketing/testkit';
import { createRedisClient } from '@ticketing/http';

import { loadConfig as loadWaitingRoomConfig } from '../apps/waitingroom/src/config.js';
import { buildServer as buildWaitingRoom } from '../apps/waitingroom/src/server.js';

import { loadConfig as loadGatewayConfig } from '../apps/gateway/src/config.js';
import { buildServer as buildGateway } from '../apps/gateway/src/server.js';

const IDENTITY_MIGRATIONS = fileURLToPath(new URL('../apps/identity/migrations', import.meta.url));
const CATALOG_MIGRATIONS = fileURLToPath(new URL('../apps/catalog/migrations', import.meta.url));
const RESERVATION_MIGRATIONS = fileURLToPath(new URL('../apps/reservation/migrations', import.meta.url));
const ORDERS_MIGRATIONS = fileURLToPath(new URL('../apps/orders/migrations', import.meta.url));

/** Shared secret for internal service-to-service calls within the test stack. */
export const TEST_SERVICE_TOKEN = 'test-internal-service-token';
export const TEST_ADMISSION_SECRET = 'test-admission-secret';

export interface Stack {
  gatewayUrl: string;
  identityUrl: string;
  /** Shared JWT settings, so a test can build another gateway against this stack. */
  jwt: { jwksUri: string; jwtIssuer: string; jwtAudience: string };
  bootstrapAdminEmail: string;
  pools: { identity: Pool; catalog: Pool; reservation: Pool; orders: Pool };
  /** The Razorpay stand-in: authorize payments, sign callbacks, build webhooks. */
  razorpay: FakeRazorpay;
  serviceToken: string;
  /** Real Redis, with chaos controls for the fail-open proof. */
  redis: TestRedis;
  admissionSecret: string;
  /** Run one admitter pass immediately instead of waiting for its timer. */
  admitNow: (eventId: string, count?: number) => Promise<string[]>;
  /** Direct URLs, used to prove a service defends itself when the edge is bypassed. */
  direct: { identity: string; catalog: string; reservation: string; orders: string; waitingroom: string };
  request: (
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string>; baseUrl?: string },
  ) => Promise<{ status: number; body: any; headers: Headers }>;
  stop: () => Promise<void>;
}

/**
 * Each service's instance is typed with its own pino Logger, so they share no
 * single FastifyInstance type. Structural typing over the three members this
 * harness actually uses keeps them interchangeable without any casting.
 */
interface RunnableApp {
  listen: (opts: { port: number; host: string }) => Promise<unknown>;
  server: Server;
  close: () => Promise<unknown>;
}

async function listen(app: RunnableApp): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('service did not bind a port');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * The real stack: four services, three databases, real HTTP between them and real
 * RS256 verification at every hop. Nothing is stubbed — this is the configuration
 * PRD §16 Phase 2 asks to be demonstrated end to end.
 */
export async function startStack(): Promise<Stack> {
  const adminUrl = inject('pgAdminUrl');

  const dbs: TestDatabase[] = [];
  const apps: RunnableApp[] = [];
  const pools: Pool[] = [];

  const identityDb = await createTestDatabase({ adminUrl, migrationsDir: IDENTITY_MIGRATIONS });
  const catalogDb = await createTestDatabase({ adminUrl, migrationsDir: CATALOG_MIGRATIONS });
  const reservationDb = await createTestDatabase({ adminUrl, migrationsDir: RESERVATION_MIGRATIONS });
  const ordersDb = await createTestDatabase({ adminUrl, migrationsDir: ORDERS_MIGRATIONS });
  dbs.push(identityDb, catalogDb, reservationDb, ordersDb);

  const razorpay = await startFakeRazorpay();
  const redis = await startRedis();
  const redisClient = createRedisClient({ url: redis.url });

  // ── identity ──────────────────────────────────────────────────────────────
  const bootstrapAdminEmail = `bootstrap.${randomUUID()}@demo.test`;
  const identityConfig = loadIdentityConfig({
    databaseUrl: identityDb.url,
    nodeEnv: 'test',
    logLevel: 'silent',
    bootstrapAdminEmail,
    // Catalog grants organizer:event / venue_admin:venue through the internal
    // route; both sides must hold the same secret for that to work here.
    internalServiceToken: TEST_SERVICE_TOKEN,
  });
  const identityPool = createPool({ databaseUrl: identityDb.url, max: 10 });
  const keys = await loadSigningKeys(identityConfig);
  const identityApp = await buildIdentity({
    config: identityConfig,
    pool: identityPool,
    keys,
    denylist: createInMemoryDenylist(),
  });
  const identityUrl = await listen(identityApp);
  apps.push(identityApp);
  pools.push(identityPool);

  const jwt = {
    jwksUri: `${identityUrl}/.well-known/jwks.json`,
    jwtIssuer: identityConfig.issuer,
    jwtAudience: identityConfig.audience,
  };

  // ── catalog ───────────────────────────────────────────────────────────────
  const catalogPool = createPool({ databaseUrl: catalogDb.url, max: 10 });
  const catalogApp = await buildCatalog({
    config: loadCatalogConfig({
      databaseUrl: catalogDb.url,
      nodeEnv: 'test',
      logLevel: 'silent',
      redisUrl: redis.url,
      // Short enough that tests observe fresh data, long enough to prove caching.
      seatmapCacheTtlSeconds: 2,
      // The real handoff: catalog → identity's internal grant route, over the
      // same service token identity was started with.
      identityUrl,
      internalServiceToken: TEST_SERVICE_TOKEN,
      ...jwt,
    }),
    pool: catalogPool,
    redis: redisClient,
  });
  const catalogUrl = await listen(catalogApp);
  apps.push(catalogApp);
  pools.push(catalogPool);

  // ── reservation ───────────────────────────────────────────────────────────
  const reservationPool = createPool({ databaseUrl: reservationDb.url, max: 20 });
  const reservationApp = await buildReservation({
    config: loadReservationConfig({
      databaseUrl: reservationDb.url,
      nodeEnv: 'test',
      logLevel: 'silent',
      janitorEnabled: false,
      internalServiceToken: TEST_SERVICE_TOKEN,
      catalogUrl,
      admissionTokenSecret: TEST_ADMISSION_SECRET,
      ...jwt,
    }),
    pool: reservationPool,
  });
  const reservationUrl = await listen(reservationApp);
  apps.push(reservationApp);
  pools.push(reservationPool);

  // ── orders ────────────────────────────────────────────────────────────────
  const ordersPool = createPool({ databaseUrl: ordersDb.url, max: 10, statementTimeoutMs: 30_000 });
  const ordersApp = await buildOrders({
    config: loadOrdersConfig({
      databaseUrl: ordersDb.url,
      nodeEnv: 'test',
      logLevel: 'silent',
      internalServiceToken: TEST_SERVICE_TOKEN,
      reservationUrl,
      catalogUrl,
      razorpayBaseUrl: razorpay.baseUrl,
      razorpayKeyId: razorpay.keyId,
      razorpayKeySecret: razorpay.keySecret,
      razorpayWebhookSecret: razorpay.webhookSecret,
      ...jwt,
    }),
    pool: ordersPool,
    // The REAL client, pointed at the stand-in endpoint: the client's own auth
    // header, request shapes and error handling are all under test.
    razorpay: createRazorpayClient({
      baseUrl: razorpay.baseUrl,
      keyId: razorpay.keyId,
      keySecret: razorpay.keySecret,
    }),
    reservation: createReservationClient({ baseUrl: reservationUrl, serviceToken: TEST_SERVICE_TOKEN }),
    catalog: createCatalogClient({ baseUrl: catalogUrl }),
  });
  const ordersUrl = await listen(ordersApp);
  apps.push(ordersApp);
  pools.push(ordersPool);

  // ── waiting room ──────────────────────────────────────────────────────────
  const waitingRoomConfig = loadWaitingRoomConfig({
    nodeEnv: 'test',
    logLevel: 'silent',
    redisUrl: redis.url,
    admissionTokenSecret: TEST_ADMISSION_SECRET,
    // Small and explicit so queue-ordering assertions are exact rather than racy.
    admissionRatePerSecond: 2,
    ssePositionIntervalMs: 150,
    ...jwt,
  });
  const waitingRoomApp = await buildWaitingRoom({ config: waitingRoomConfig, redis: redisClient });
  const waitingRoomUrl = await listen(waitingRoomApp);
  apps.push(waitingRoomApp);

  // The admitter is driven explicitly by tests rather than by its timer, so
  // "who got admitted" is deterministic instead of a race against wall-clock.
  const { admitBatch } = await import('../apps/waitingroom/src/queue.js');

  // ── gateway ───────────────────────────────────────────────────────────────
  const gatewayApp = await buildGateway({
    config: loadGatewayConfig({
      nodeEnv: 'test',
      logLevel: 'silent',
      identityUrl,
      catalogUrl,
      reservationUrl,
      ordersUrl,
      waitingRoomUrl,
      redisUrl: redis.url,
      admissionTokenSecret: TEST_ADMISSION_SECRET,
      ...jwt,
      // High enough that the functional tests never trip it; a dedicated test
      // builds its own gateway with a low limit instead.
      rateLimitMax: 10_000,
    }),
  });
  const gatewayUrl = await listen(gatewayApp);
  apps.push(gatewayApp);

  const request: Stack['request'] = async (method, path, options = {}) => {
    // Only declare a JSON body when there is one: Fastify rejects a request that
    // announces application/json and then sends nothing, which is the right
    // behaviour and a real bug in any client that does it.
    const response = await fetch(`${options.baseUrl ?? gatewayUrl}${path}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text), headers: response.headers };
  };

  return {
    gatewayUrl,
    identityUrl,
    jwt,
    bootstrapAdminEmail,
    pools: { identity: identityPool, catalog: catalogPool, reservation: reservationPool, orders: ordersPool },
    razorpay,
    serviceToken: TEST_SERVICE_TOKEN,
    redis,
    admissionSecret: TEST_ADMISSION_SECRET,
    admitNow: async (eventId, count = 1) =>
      admitBatch(redisClient, { eventId, count, ttlSeconds: waitingRoomConfig.admissionTtlSeconds }),
    direct: {
      identity: identityUrl,
      catalog: catalogUrl,
      reservation: reservationUrl,
      orders: ordersUrl,
      waitingroom: waitingRoomUrl,
    },
    request,
    stop: async () => {
      for (const app of apps.reverse()) await app.close();
      for (const pool of pools) await pool.end();
      for (const db of dbs) await db.drop();
      await razorpay.stop();
      redisClient.disconnect();
      await redis.stop();
    },
  };
}

/** Promote a user to platform_admin by writing the grant identity itself owns. */
export async function makePlatformAdmin(identityPool: Pool, userId: string): Promise<void> {
  await identityPool.query(
    `INSERT INTO role_assignments (user_id, role) VALUES ($1, 'platform_admin') ON CONFLICT DO NOTHING`,
    [userId],
  );
}
