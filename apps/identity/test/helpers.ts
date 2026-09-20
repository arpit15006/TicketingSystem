import { fileURLToPath } from 'node:url';
import { inject } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@ticketing/http';
import { createTestDatabase, type TestDatabase } from '@ticketing/testkit';
import { loadConfig } from '../src/config.js';
import { loadSigningKeys } from '../src/keys.js';
import { createInMemoryDenylist } from '../src/denylist.js';
import { buildServer, type IdentityServer } from '../src/server.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
export const TEST_SERVICE_TOKEN = 'test-internal-service-token';

export interface Harness {
  app: IdentityServer;
  pool: Pool;
  db: TestDatabase;
  baseUrl: string;
  post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  get: (path: string, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  register: (email?: string) => Promise<{ userId: string; accessToken: string; refreshToken: string; email: string; password: string }>;
  /** Header proving a caller is another service — for the internal grant route. */
  serviceHeaders: Record<string, string>;
  stop: () => Promise<void>;
}

let counter = 0;

export async function startHarness(overrides: { accessTokenTtlSeconds?: number } = {}): Promise<Harness> {
  const db = await createTestDatabase({ adminUrl: inject('pgAdminUrl'), migrationsDir: MIGRATIONS_DIR });

  const config = loadConfig({
    databaseUrl: db.url,
    nodeEnv: 'test',
    logLevel: 'silent',
    internalServiceToken: TEST_SERVICE_TOKEN,
    ...(overrides.accessTokenTtlSeconds === undefined ? {} : { accessTokenTtlSeconds: overrides.accessTokenTtlSeconds }),
  });

  const pool = createPool({ databaseUrl: db.url, max: 10 });
  const keys = await loadSigningKeys(config);
  const app = await buildServer({ config, pool, keys, denylist: createInMemoryDenylist() });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('identity did not bind a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const post: Harness['post'] = async (path, body, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  };

  const get: Harness['get'] = async (path, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { headers });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  };

  return {
    app,
    pool,
    db,
    baseUrl,
    post,
    get,
    serviceHeaders: { 'x-internal-token': TEST_SERVICE_TOKEN },
    register: async (email?: string) => {
      counter += 1;
      const address = email ?? `user${counter}.${Date.now()}@example.com`;
      const password = 'correct horse battery staple';
      const result = await post('/auth/register', { email: address, password, fullName: 'Test User' });
      if (result.status !== 201) throw new Error(`register failed: ${result.status} ${JSON.stringify(result.body)}`);
      return { ...result.body, email: address, password };
    },
    stop: async () => {
      await app.close();
      await pool.end();
      await db.drop();
    },
  };
}
