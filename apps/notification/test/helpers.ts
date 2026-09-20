import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@ticketing/http';
import { createKafkaProducer, createKafkaConsumer, createOutboxRelay, type OutboxRelay } from '@ticketing/kafka';
import { Topics, type EventTypeName } from '@ticketing/contracts';
import { createTestDatabase, startRedpanda, type TestBroker, type TestDatabase } from '@ticketing/testkit';
import { handleEvent } from '../src/handlers.js';

export const NOTIFICATION_MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url));
export const RESERVATION_MIGRATIONS = fileURLToPath(new URL('../../reservation/migrations', import.meta.url));

const silentLogger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

export interface EventHarness {
  broker: TestBroker;
  /** Stands in for a producing service's database (reservation's schema). */
  producerDb: TestDatabase;
  producerPool: Pool;
  notificationDb: TestDatabase;
  notificationPool: Pool;
  relay: OutboxRelay;
  /** Write an event into the outbox exactly as a service transaction would. */
  writeOutbox: (args: { eventType: EventTypeName; aggregateId?: string; payload?: unknown; requestId?: string }) => Promise<string>;
  unpublishedCount: () => Promise<number>;
  publishedCount: () => Promise<number>;
  processedCount: () => Promise<number>;
  notificationCount: () => Promise<number>;
  /** Poll until a predicate holds, or fail — never a blind sleep. */
  waitFor: (predicate: () => Promise<boolean>, description: string, timeoutMs?: number) => Promise<void>;
  stop: () => Promise<void>;
}

export async function startEventHarness(): Promise<EventHarness> {
  const adminUrl = inject('pgAdminUrl');
  const broker = await startRedpanda();

  const producerDb = await createTestDatabase({ adminUrl, migrationsDir: RESERVATION_MIGRATIONS });
  const notificationDb = await createTestDatabase({ adminUrl, migrationsDir: NOTIFICATION_MIGRATIONS });

  const producerPool = createPool({ databaseUrl: producerDb.url, max: 10 });
  const notificationPool = createPool({ databaseUrl: notificationDb.url, max: 10 });

  const relay = createOutboxRelay({
    pool: producerPool,
    publisher: createKafkaProducer({ brokers: broker.brokers, clientId: 'test-relay' }),
    serviceName: 'reservation',
    intervalMs: 100,
    logger: silentLogger,
  });

  const consumer = createKafkaConsumer({
    brokers: broker.brokers,
    clientId: 'test-notification',
    groupId: `notification-${randomUUID()}`,
    topics: [Topics.orderConfirmed, Topics.orderCompensated, Topics.paymentFailed, Topics.seatSold],
    logger: silentLogger,
    handle: async (envelope) => {
      await handleEvent(notificationPool, envelope, silentLogger);
    },
  });
  await consumer.start();

  const count = async (pool: Pool, sql: string): Promise<number> => {
    const result = await pool.query<{ count: string }>(sql);
    return Number(result.rows[0]?.count ?? 0);
  };

  return {
    broker,
    producerDb,
    producerPool,
    notificationDb,
    notificationPool,
    relay,

    writeOutbox: async (args) => {
      const inserted = await producerPool.query<{ id: string }>(
        `INSERT INTO outbox (aggregate_id, event_type, payload, request_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          args.aggregateId ?? randomUUID(),
          args.eventType,
          JSON.stringify(args.payload ?? { userId: randomUUID(), seatIds: [randomUUID()] }),
          args.requestId ?? randomUUID(),
        ],
      );
      return inserted.rows[0]!.id;
    },

    unpublishedCount: () => count(producerPool, `SELECT count(*) FROM outbox WHERE published_at IS NULL`),
    publishedCount: () => count(producerPool, `SELECT count(*) FROM outbox WHERE published_at IS NOT NULL`),
    processedCount: () => count(notificationPool, `SELECT count(*) FROM processed_events`),
    notificationCount: () => count(notificationPool, `SELECT count(*) FROM notifications`),

    waitFor: async (predicate, description, timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for: ${description}`);
    },

    stop: async () => {
      await relay.stop();
      await consumer.stop();
      await producerPool.end();
      await notificationPool.end();
      await producerDb.drop();
      await notificationDb.drop();
      await broker.stop();
    },
  };
}
