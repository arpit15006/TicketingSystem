import { createPool } from '@ticketing/http';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { createRazorpayClient } from './razorpay.js';
import { createReservationClient, createCatalogClient } from './clients.js';

const config = loadConfig();
const pool = createPool({ databaseUrl: config.databaseUrl, max: config.pgPoolMax, statementTimeoutMs: 30_000 });

const app = await buildServer({
  config,
  pool,
  razorpay: createRazorpayClient({
    baseUrl: config.razorpayBaseUrl,
    keyId: config.razorpayKeyId,
    keySecret: config.razorpayKeySecret,
  }),
  reservation: createReservationClient({
    baseUrl: config.reservationUrl,
    serviceToken: config.internalServiceToken,
  }),
  catalog: createCatalogClient({ baseUrl: config.catalogUrl }),
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
