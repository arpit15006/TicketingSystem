import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PostgresServer {
  /** Admin connection URL pointing at the `postgres` maintenance database. */
  adminUrl: string;
  provider: 'testcontainers' | 'embedded';
  stop: () => Promise<void>;
}

/**
 * Docker Desktop on macOS does not create /var/run/docker.sock; the socket lives
 * under the user's home directory and the active docker *context* points at it.
 * Testcontainers reads DOCKER_HOST, so resolve it explicitly rather than depending
 * on ambient configuration that differs between laptops and CI.
 */
export function resolveDockerHost(): string | null {
  const explicit = process.env['DOCKER_HOST'];
  if (explicit !== undefined && explicit !== '') return explicit;

  const candidates = [
    join(homedir(), '.docker', 'run', 'docker.sock'),
    '/var/run/docker.sock',
    join(homedir(), '.colima', 'default', 'docker.sock'),
  ];
  for (const socket of candidates) {
    if (existsSync(socket)) return `unix://${socket}`;
  }
  return null;
}

/**
 * PRD §15.1 requires real infrastructure — a real PostgreSQL, never a mock.
 *
 * Testcontainers is the primary path and the one CI uses. The embedded fallback
 * exists only so the suite still runs against a REAL PostgreSQL 16 server when no
 * Docker daemon is reachable (see docs/ENVIRONMENT_AUDIT.md, DEV-2). Both paths run
 * identical migrations and identical SQL; the code under test cannot tell them apart.
 */
export async function startPostgresServer(): Promise<PostgresServer> {
  const dockerHost = resolveDockerHost();

  if (dockerHost !== null) {
    process.env['DOCKER_HOST'] = dockerHost;
    try {
      const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
      const container = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('postgres')
        .withUsername('postgres')
        .withPassword('postgres')
        // A thousand concurrent bookings open a lot of backends; the default 100 is
        // the first thing to run out and it would look like an application bug.
        .withCommand(['postgres', '-c', 'max_connections=300', '-c', 'fsync=off'])
        .start();

      return {
        adminUrl: `postgresql://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/postgres`,
        provider: 'testcontainers',
        stop: async () => {
          await container.stop();
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[testkit] Testcontainers unavailable (${reason}); falling back to embedded PostgreSQL 16.`);
    }
  }

  return startEmbedded();
}

async function startEmbedded(): Promise<PostgresServer> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = 5500 + Math.floor(Math.random() * 400);
  const databaseDir = join(process.cwd(), '.pgdata', `test-${process.pid}-${port}`);

  const server = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    postgresFlags: ['-c', 'max_connections=300', '-c', 'fsync=off'],
  });

  await server.initialise();
  await server.start();

  return {
    adminUrl: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    provider: 'embedded',
    stop: async () => {
      await server.stop();
    },
  };
}
