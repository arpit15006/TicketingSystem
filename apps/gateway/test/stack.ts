import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { createPool } from '@ticketing/http';
import { createTestDatabase, type TestDatabase } from '@ticketing/testkit';

import { loadConfig as loadIdentityConfig } from '../../identity/src/config.js';
import { loadSigningKeys } from '../../identity/src/keys.js';
import { createInMemoryDenylist } from '../../identity/src/denylist.js';
import { buildServer as buildIdentity } from '../../identity/src/server.js';

import { loadConfig as loadCatalogConfig } from '../../catalog/src/config.js';
import { buildServer as buildCatalog } from '../../catalog/src/server.js';

import { loadConfig as loadReservationConfig } from '../../reservation/src/config.js';
import { buildServer as buildReservation } from '../../reservation/src/server.js';

import { loadConfig as loadGatewayConfig } from '../src/config.js';
import { buildServer as buildGateway } from '../src/server.js';

const IDENTITY_MIGRATIONS = fileURLToPath(new URL('../../identity/migrations', import.meta.url));
const CATALOG_MIGRATIONS = fileURLToPath(new URL('../../catalog/migrations', import.meta.url));
const RESERVATION_MIGRATIONS = fileURLToPath(new URL('../../reservation/migrations', import.meta.url));

export interface Stack {
  gatewayUrl: string;
  identityUrl: string;
  /** Shared JWT settings, so a test can build another gateway against this stack. */
  jwt: { jwksUri: string; jwtIssuer: string; jwtAudience: string };
  bootstrapAdminEmail: string;
  pools: { identity: Pool; catalog: Pool; reservation: Pool };
  /** Direct URLs, used to prove a service defends itself when the edge is bypassed. */
  direct: { identity: string; catalog: string; reservation: string };
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
  dbs.push(identityDb, catalogDb, reservationDb);

  // ── identity ──────────────────────────────────────────────────────────────
  const bootstrapAdminEmail = `bootstrap.${randomUUID()}@demo.test`;
  const identityConfig = loadIdentityConfig({
    databaseUrl: identityDb.url,
    nodeEnv: 'test',
    logLevel: 'silent',
    bootstrapAdminEmail,
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
    config: loadCatalogConfig({ databaseUrl: catalogDb.url, nodeEnv: 'test', logLevel: 'silent', ...jwt }),
    pool: catalogPool,
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
      ...jwt,
    }),
    pool: reservationPool,
  });
  const reservationUrl = await listen(reservationApp);
  apps.push(reservationApp);
  pools.push(reservationPool);

  // ── gateway ───────────────────────────────────────────────────────────────
  const gatewayApp = await buildGateway({
    config: loadGatewayConfig({
      nodeEnv: 'test',
      logLevel: 'silent',
      identityUrl,
      catalogUrl,
      reservationUrl,
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
    pools: { identity: identityPool, catalog: catalogPool, reservation: reservationPool },
    direct: { identity: identityUrl, catalog: catalogUrl, reservation: reservationUrl },
    request,
    stop: async () => {
      for (const app of apps.reverse()) await app.close();
      for (const pool of pools) await pool.end();
      for (const db of dbs) await db.drop();
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
