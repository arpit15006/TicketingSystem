import { createPool } from '@ticketing/http';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const pool = createPool({ databaseUrl: config.databaseUrl, max: config.pgPoolMax });
const app = await buildServer({ config, pool });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
