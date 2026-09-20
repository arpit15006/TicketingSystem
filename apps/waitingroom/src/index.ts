import { createRedisClient } from '@ticketing/http';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { startAdmitter } from './admitter.js';

const config = loadConfig();
const redis = createRedisClient({ url: config.redisUrl });
const app = await buildServer({ config, redis });

redis.on('error', (error: Error) => {
  // Logged, never fatal: a waiting room without Redis fails open (ADR-012).
  app.log.warn({ err: error.message }, 'redis error (waiting room will fail open)');
});

const stopAdmitter = startAdmitter({
  redis,
  ratePerSecond: config.admissionRatePerSecond,
  intervalMs: config.admitterIntervalMs,
  admissionTtlSeconds: config.admissionTtlSeconds,
  logger: app.log,
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  stopAdmitter();
  await app.close();
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
