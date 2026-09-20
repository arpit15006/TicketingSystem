import { createServer } from 'node:net';
import Docker from 'dockerode';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { resolveDockerHost } from './postgres-server.js';

export interface TestRedis {
  url: string;
  /** Stop Redis. The container is kept so it returns on the same address. */
  kill: () => Promise<void>;
  revive: () => Promise<void>;
  stop: () => Promise<void>;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not allocate a port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * A real Redis 7 (PRD §3, §15.1 — no mocked infrastructure).
 *
 * As with the broker, the host port is pinned and the chaos controls drive Docker
 * directly: testcontainers' own `stop()` is a no-op the second time after a
 * restart, which would silently leave Redis running during a test that believes it
 * killed it.
 */
export async function startRedis(): Promise<TestRedis> {
  const hostPort = await findFreePort();

  const container: StartedTestContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts({ container: 6379, host: hostPort })
    .start();

  const socketPath = resolveDockerHost()?.replace(/^unix:\/\//, '');
  const docker = new Docker(socketPath === undefined ? {} : { socketPath });
  const handle = docker.getContainer(container.getId());

  const url = `redis://127.0.0.1:${hostPort}`;

  return {
    url,
    kill: async () => {
      await handle.stop({ t: 2 }).catch((error: unknown) => {
        if ((error as { statusCode?: number }).statusCode !== 304) throw error;
      });
    },
    revive: async () => {
      await handle.start().catch((error: unknown) => {
        if ((error as { statusCode?: number }).statusCode !== 304) throw error;
      });
      // Wait for it to actually answer, so a later failure is the test's own.
      const { Redis: IORedis } = await import('ioredis');
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const probe = new IORedis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
        try {
          await probe.connect();
          await probe.ping();
          probe.disconnect();
          return;
        } catch {
          probe.disconnect();
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      throw new Error('Redis did not become reachable after restart');
    },
    stop: async () => {
      await container.stop();
    },
  };
}
