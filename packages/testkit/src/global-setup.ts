import { startPostgresServer, type PostgresServer } from './postgres-server.js';
import type { TestProject } from 'vitest/node';
// Pulls the module into scope so the `declare module 'vitest'` augmentation resolves.
import type {} from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgProvider: 'testcontainers' | 'embedded';
  }
}

let server: PostgresServer | undefined;

/**
 * One real PostgreSQL server for the whole integration run; each suite then creates
 * its own logical database. Starting a container per file would triple the runtime
 * without testing anything extra — the isolation that matters is per-database.
 */
export async function setup(project: TestProject): Promise<void> {
  server = await startPostgresServer();
  project.provide('pgAdminUrl', server.adminUrl);
  project.provide('pgProvider', server.provider);
  console.log(`[testkit] integration infrastructure: real PostgreSQL via ${server.provider}`);
}

export async function teardown(): Promise<void> {
  await server?.stop();
  server = undefined;
}
