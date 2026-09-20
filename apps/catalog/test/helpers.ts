import { fileURLToPath } from 'node:url';
import { inject } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@ticketing/http';
import { createTestDatabase, startTestIdentity, type TestDatabase, type TestIdentity } from '@ticketing/testkit';
import type { RoleGrant } from '@ticketing/contracts';
import { loadConfig } from '../src/config.js';
import { buildServer, type CatalogServer } from '../src/server.js';
import type { IdentityClient } from '../src/identity-client.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface Harness {
  app: CatalogServer;
  pool: Pool;
  db: TestDatabase;
  baseUrl: string;
  identity: TestIdentity;
  /** Every grant catalog asked identity for, in order. */
  grants: { userId: string; role: string; resourceType: string; resourceId: string }[];
  /** Make the next grant call fail, to prove creation rolls back with it. */
  failNextGrant: () => void;
  /** Users the fake identity knows, by email. */
  users: Map<string, { userId: string; email: string; fullName: string }>;
  as: (roles: RoleGrant[], userId?: string) => Promise<Record<string, string>>;
  request: (
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: any }>;
  stop: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const db = await createTestDatabase({ adminUrl: inject('pgAdminUrl'), migrationsDir: MIGRATIONS_DIR });
  const identity = await startTestIdentity();

  const config = loadConfig({
    databaseUrl: db.url,
    nodeEnv: 'test',
    logLevel: 'silent',
    jwksUri: identity.jwksUri,
    jwtIssuer: identity.issuer,
    jwtAudience: identity.audience,
  });

  const pool = createPool({ databaseUrl: db.url, max: 10 });

  /*
   * The real client would call identity over HTTP. Here it is replaced by one
   * that records what catalog asked for, so tests can assert that creating an
   * event or a venue produced exactly the grant PRD §9.2 requires — and can make
   * the grant fail to prove the INSERT rolls back with it.
   */
  const grants: Harness['grants'] = [];
  const users: Harness['users'] = new Map();
  let failNext = false;
  const fakeIdentity: IdentityClient = {
    findByEmail: async (email) => users.get(email) ?? null,
    grant: async (args) => {
      if (failNext) {
        failNext = false;
        throw new Error('identity unavailable (simulated)');
      }
      grants.push(args);
      return [{ role: args.role, resourceType: args.resourceType, resourceId: args.resourceId }];
    },
  };

  const app = await buildServer({ config, pool, identity: fakeIdentity });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('catalog did not bind a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    pool,
    db,
    baseUrl,
    identity,
    grants,
    users,
    failNextGrant: () => {
      failNext = true;
    },
    as: async (roles, userId) => ({
      authorization: `Bearer ${await identity.mint({ roles, ...(userId === undefined ? {} : { userId }) })}`,
    }),
    request: async (method, path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text === '' ? null : JSON.parse(text) };
    },
    stop: async () => {
      await app.close();
      await pool.end();
      await db.drop();
      await identity.stop();
    },
  };
}

export const global = (role: RoleGrant['role']): RoleGrant => ({ role, resourceType: null, resourceId: null });
export const scoped = (role: RoleGrant['role'], resourceType: 'event' | 'venue', resourceId: string): RoleGrant => ({
  role,
  resourceType,
  resourceId,
});
