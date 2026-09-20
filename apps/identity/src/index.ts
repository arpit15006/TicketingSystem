import { createPool, createRedisClient } from '@ticketing/http';
import { loadConfig } from './config.js';
import { loadSigningKeys } from './keys.js';
import { createInMemoryDenylist, createRedisDenylist } from './denylist.js';
import { buildServer } from './server.js';

const config = loadConfig();
const pool = createPool({ databaseUrl: config.databaseUrl, max: config.pgPoolMax });
const keys = await loadSigningKeys(config);
// ADR-011 — a denylist that is not shared between replicas barely is one.
const redis = config.redisUrl === '' ? null : createRedisClient({ url: config.redisUrl });
const denylist = redis === null ? createInMemoryDenylist() : createRedisDenylist(redis);
const app = await buildServer({ config, pool, keys, denylist });

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
