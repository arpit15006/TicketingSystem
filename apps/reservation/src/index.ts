import { createKafkaProducer, createOutboxRelay } from '@ticketing/kafka';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { buildServer } from './server.js';
import { startJanitor } from './janitor.js';

const config = loadConfig();
const pool = createPool({ databaseUrl: config.databaseUrl, max: config.pgPoolMax, statementTimeoutMs: config.statementTimeoutMs });
const app = await buildServer({ config, pool });

const stopJanitor = config.janitorEnabled ? startJanitor(pool, app.log, config.janitorIntervalMs) : () => {};

// ADR-005 — publishes rows the transactions already committed. If this worker
// never runs, nothing is lost and nothing oversells; the events simply wait.
const relay = config.outboxRelayEnabled
  ? createOutboxRelay({
      pool,
      publisher: createKafkaProducer({ brokers: config.kafkaBrokers, clientId: 'reservation-relay' }),
      serviceName: 'reservation',
      intervalMs: config.outboxRelayIntervalMs,
      logger: app.log,
    })
  : null;
relay?.start();

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  stopJanitor();
  await relay?.stop();
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
