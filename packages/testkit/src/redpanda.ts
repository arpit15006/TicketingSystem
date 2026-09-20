import { createServer } from 'node:net';
import { Kafka, logLevel } from 'kafkajs';
import Docker from 'dockerode';
import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import { resolveDockerHost } from './postgres-server.js';

export interface TestBroker {
  brokers: string[];
  /** Stop the broker. The container is kept so it can come back on the same address. */
  kill: () => Promise<void>;
  /** Restart it and wait until it actually accepts connections again. */
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

async function isReachable(brokers: string[]): Promise<boolean> {
  const admin = new Kafka({
    clientId: 'testkit-probe',
    brokers,
    logLevel: logLevel.NOTHING,
    connectionTimeout: 3_000,
    retry: { retries: 1, initialRetryTime: 100 },
  }).admin();

  try {
    await admin.connect();
    await admin.listTopics();
    await admin.disconnect();
    return true;
  } catch {
    try {
      await admin.disconnect();
    } catch {
      // Already broken; nothing to clean up.
    }
    return false;
  }
}

/**
 * A real Redpanda broker (PRD §3, §15.1 — no mocked infrastructure).
 *
 * The host port is pinned rather than left ephemeral, which matters for the chaos
 * test: Docker assigns a NEW random host port when a container with a random
 * binding restarts, so the broker would come back at an address no client knows.
 * A real broker returns on the address it left, and pinning reproduces that. The
 * alternative — reconfiguring clients mid-test — would be testing a scenario that
 * does not happen in production.
 */
export async function startRedpanda(): Promise<TestBroker> {
  const hostPort = await findFreePort();

  const container: StartedRedpandaContainer = await new RedpandaContainer(
    'docker.redpanda.com/redpandadata/redpanda:v24.3.6',
  )
    .withExposedPorts({ container: 9092, host: hostPort })
    .start();

  const brokers = [container.getBootstrapServers().replace(/^.*:\/\//, '')];

  /*
   * The chaos controls talk to Docker directly rather than through
   * StartedTestContainer.
   *
   * Testcontainers tracks a container's stopped state internally, and that state
   * is not cleared by restart(): a SECOND stop() after a restart resolves without
   * doing anything, leaving the broker running while the test believes it is
   * down. Verified directly — a chaos test that cannot actually kill the thing it
   * is chaos-testing is worse than no test at all.
   */
  const socketPath = resolveDockerHost()?.replace(/^unix:\/\//, '');
  const docker = new Docker(socketPath === undefined ? {} : { socketPath });
  const handle = docker.getContainer(container.getId());

  return {
    brokers,

    kill: async () => {
      await handle.stop({ t: 5 }).catch((error: unknown) => {
        // 304 = already stopped, which is the state we wanted anyway.
        const status = (error as { statusCode?: number }).statusCode;
        if (status !== 304) throw error;
      });
    },

    revive: async () => {
      await handle.start().catch((error: unknown) => {
        // 304 = already running.
        const status = (error as { statusCode?: number }).statusCode;
        if (status !== 304) throw error;
      });

      // Docker reporting the container as started is not the same as Redpanda
      // accepting Kafka connections. Wait for the real thing, so a test that
      // fails after this point failed for its own reasons.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (await isReachable(brokers)) return;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      throw new Error('Redpanda did not become reachable after restart');
    },

    stop: async () => {
      await container.stop();
    },
  };
}
