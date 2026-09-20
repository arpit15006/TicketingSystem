import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

const { Client, Pool } = pg;

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  drop: () => Promise<void>;
}

function replaceDatabase(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Create a fresh logical database and run the service's real migrations against it.
 *
 * Migrations are run, never a hand-written CREATE TABLE copy: if the migration is
 * broken, the integration suite must fail rather than quietly test a schema that
 * production will never have.
 */
export async function createTestDatabase(args: {
  adminUrl: string;
  migrationsDir: string;
  name?: string;
}): Promise<TestDatabase> {
  const database = args.name ?? `test_${randomUUID().replace(/-/g, '')}`;

  const admin = new Client({ connectionString: args.adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${JSON.stringify(database).replace(/"/g, '"')}`);
  await admin.end();

  const url = replaceDatabase(args.adminUrl, database);

  await runner({
    databaseUrl: url,
    dir: args.migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: () => {},
  });

  const pool = new Pool({ connectionString: url, max: 20 });
  // DROP DATABASE ... WITH FORCE terminates live backends (57P01). Without a
  // listener that arrives as an uncaught exception and fails an otherwise green run.
  pool.on('error', () => {});

  return {
    url,
    pool,
    drop: async () => {
      await pool.end();
      const cleanup = new Client({ connectionString: args.adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** Run a service's migrations down then up again — proves they are reversible. */
export async function migrateDown(url: string, migrationsDir: string, count: number): Promise<void> {
  await runner({
    databaseUrl: url,
    dir: migrationsDir,
    direction: 'down',
    migrationsTable: 'pgmigrations',
    count,
    log: () => {},
  });
}

export async function migrateUp(url: string, migrationsDir: string): Promise<void> {
  await runner({
    databaseUrl: url,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: () => {},
  });
}
