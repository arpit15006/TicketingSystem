import { createPool } from '@ticketing/http';
import { createKafkaConsumer } from '@ticketing/kafka';
import { Topics } from '@ticketing/contracts';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { handleEvent } from './handlers.js';

const config = loadConfig();
const pool = createPool({ databaseUrl: config.databaseUrl, max: config.pgPoolMax });
const app = await buildServer({ config, pool });

const consumer = createKafkaConsumer({
  brokers: config.kafkaBrokers,
  clientId: 'notification',
  groupId: config.consumerGroupId,
  topics: [Topics.orderConfirmed, Topics.orderCompensated, Topics.paymentFailed, Topics.seatSold],
  logger: app.log,
  handle: async (envelope) => {
    await handleEvent(pool, envelope, app.log);
  },
});

await consumer.start();

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await consumer.stop();
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
