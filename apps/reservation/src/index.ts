import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { buildServer } from './server.js';
import { startJanitor } from './janitor.js';

const config = loadConfig();
const pool = createPool({ databaseUrl: config.databaseUrl, max: config.pgPoolMax, statementTimeoutMs: config.statementTimeoutMs });
const app = await buildServer({ config, pool });

const stopJanitor = config.janitorEnabled ? startJanitor(pool, app.log, config.janitorIntervalMs) : () => {};

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  stopJanitor();
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
