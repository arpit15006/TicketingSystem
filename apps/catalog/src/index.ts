import { createPool, createRedisClient } from '@ticketing/http';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const pool = createPool({ databaseUrl: config.databaseUrl, max: config.pgPoolMax });
const redis = config.redisUrl === '' ? null : createRedisClient({ url: config.redisUrl });
const app = await buildServer({ config, pool, redis });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  redis?.disconnect();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
