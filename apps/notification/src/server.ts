import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import { createLogger } from '@ticketing/logger';
import { requestIdPlugin, errorHandlerPlugin, authPlugin, requireAuth } from '@ticketing/http';
import type { Config } from './config.js';

export type NotificationServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

/**
 * A minimal HTTP surface. The real work is the Kafka consumer; this exists so the
 * container has a healthcheck and so notifications can be inspected in a demo.
 */
export async function buildServer({ config, pool }: { config: Config; pool: Pool }): Promise<NotificationServer> {
  const app = Fastify({
    loggerInstance: createLogger({
      service: 'notification',
      level: config.logLevel,
      pretty: config.nodeEnv === 'development',
    }),
  });

  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, {
    jwksUri: config.jwksUri,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'notification' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  /**
   * The caller's own notifications, and nobody else's.
   *
   * The first version took `userId` as a query parameter with no authentication
   * at all — anyone could read anyone's order confirmations by guessing an id.
   * The filter is now the verified subject of the token (ADR-010): there is no
   * request shape that names another user.
   */
  app.get('/notifications', async (req) => {
    const auth = requireAuth(req);
    const { limit } = req.query as { limit?: string };
    const max = Math.min(Number(limit ?? 50) || 50, 200);

    const rows = await pool.query(
      `SELECT notification_id, event_id, kind, subject, body, request_id, delivered_at, created_at
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [auth.userId, max],
    );
    return { notifications: rows.rows };
  });

  return app;
}
