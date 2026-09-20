import { createPool } from '@ticketing/http';
import { loadConfig } from './config.js';
import { loadSigningKeys } from './keys.js';
import { createInMemoryDenylist } from './denylist.js';
import { buildServer } from './server.js';

const config = loadConfig();
const pool = createPool({ databaseUrl: config.databaseUrl, max: config.pgPoolMax });
const keys = await loadSigningKeys(config);
const denylist = createInMemoryDenylist();
const app = await buildServer({ config, pool, keys, denylist });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
