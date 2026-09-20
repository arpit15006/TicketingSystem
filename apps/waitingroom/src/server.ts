import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { createLogger } from '@ticketing/logger';
import { requestIdPlugin, errorHandlerPlugin, authPlugin, requireAuth, type Redis } from '@ticketing/http';
import type { Config } from './config.js';
import { join, status, mintAdmissionToken } from './queue.js';

export type WaitingRoomServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger,
  TypeBoxTypeProvider
>;

const UUID = Type.String({ format: 'uuid' });

export async function buildServer({ config, redis }: { config: Config; redis: Redis }): Promise<WaitingRoomServer> {
  const app = Fastify({
    loggerInstance: createLogger({
      service: 'waitingroom',
      level: config.logLevel,
      pretty: config.nodeEnv === 'development',
    }),
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return (Array.isArray(header) ? header[0] : header) ?? '';
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, {
    jwksUri: config.jwksUri,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'waitingroom' }));

  /** Readiness reports Redis state but stays 200: a degraded queue is still usable. */
  app.get('/readyz', async () => {
    try {
      await redis.ping();
      return { status: 'ready', redis: 'up' };
    } catch {
      return { status: 'ready', redis: 'down', degraded: true };
    }
  });

  /* ------------------------------------------------ POST /queue/:eventId/join */

  app.post('/queue/:eventId/join', { schema: { params: Type.Object({ eventId: UUID }) } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { eventId } = req.params;

    const result = await join(redis, eventId, auth.userId);
    const current = await status(redis, { eventId, userId: auth.userId, ratePerSecond: config.admissionRatePerSecond });

    /*
     * ADR-012 — FAIL OPEN.
     *
     * When Redis is unreachable there is no queue to stand in, so the user is
     * admitted immediately with a real admission token. The alternative — refusing
     * entry because the *queue* is broken — would turn a cache outage into a total
     * outage, and would be fail-CLOSED on a component that protects nothing.
     * Seat allocation stays exactly correct either way (INV-7).
     */
    if (result.degraded) {
      req.log.warn({ eventId }, 'waiting room degraded: Redis unavailable, admitting immediately');
      return reply.status(200).send({
        eventId,
        degraded: true,
        admitted: true,
        position: 0,
        total: 0,
        estimatedWaitSeconds: 0,
        admissionToken: await mintAdmissionToken({
          secret: config.admissionTokenSecret,
          eventId,
          userId: auth.userId,
          ttlSeconds: config.admissionTtlSeconds,
        }),
      });
    }

    return reply.status(200).send({
      eventId,
      degraded: false,
      admitted: current.admitted,
      position: current.position,
      total: current.total,
      estimatedWaitSeconds: current.estimatedWaitSeconds,
      ...(current.admitted
        ? {
            admissionToken: await mintAdmissionToken({
              secret: config.admissionTokenSecret,
              eventId,
              userId: auth.userId,
              ttlSeconds: config.admissionTtlSeconds,
            }),
          }
        : {}),
    });
  });

  /* ---------------------------------------------- GET /queue/:eventId/status */

  /** Polling equivalent of the SSE stream — simpler for clients that want one shot. */
  app.get('/queue/:eventId/status', { schema: { params: Type.Object({ eventId: UUID }) } }, async (req) => {
    const auth = requireAuth(req);
    const { eventId } = req.params;
    const current = await status(redis, { eventId, userId: auth.userId, ratePerSecond: config.admissionRatePerSecond });

    return {
      eventId,
      ...current,
      ...(current.admitted
        ? {
            admissionToken: await mintAdmissionToken({
              secret: config.admissionTokenSecret,
              eventId,
              userId: auth.userId,
              ttlSeconds: config.admissionTtlSeconds,
            }),
          }
        : {}),
    };
  });

  /* -------------------------------------------- GET /queue/:eventId/position */

  /**
   * PRD §12 / ADR-016 — Server-Sent Events, pushing position every 2 seconds.
   *
   * SSE rather than WebSockets because the traffic is strictly one-directional:
   * the server pushes a position, the client never sends anything. SSE is plain
   * HTTP, so it passes through the existing gateway, auth and load balancer with
   * no special handling, and it reconnects on its own with `Last-Event-ID`.
   */
  app.get('/queue/:eventId/position', { schema: { params: Type.Object({ eventId: UUID }) } }, async (req, reply) => {
    const auth = requireAuth(req);
    const { eventId } = req.params;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would defeat the point of streaming.
      'x-accel-buffering': 'no',
    });

    let eventCounter = 0;
    let closed = false;

    const send = (event: string, data: unknown): void => {
      if (closed) return;
      eventCounter += 1;
      reply.raw.write(`id: ${eventCounter}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const push = async (): Promise<void> => {
      const current = await status(redis, { eventId, userId: auth.userId, ratePerSecond: config.admissionRatePerSecond });

      if (current.admitted) {
        send('admitted', {
          eventId,
          degraded: current.degraded,
          admissionToken: await mintAdmissionToken({
            secret: config.admissionTokenSecret,
            eventId,
            userId: auth.userId,
            ttlSeconds: config.admissionTtlSeconds,
          }),
        });
        // Nothing further to say; the client proceeds to the seatmap.
        cleanup();
        reply.raw.end();
        return;
      }

      send('position', {
        position: current.position,
        total: current.total,
        estimatedWaitSeconds: current.estimatedWaitSeconds,
        degraded: current.degraded,
      });
    };

    const timer = setInterval(() => {
      void push();
    }, config.ssePositionIntervalMs);

    const cleanup = (): void => {
      closed = true;
      clearInterval(timer);
    };

    // A client that navigates away must not leave a timer running forever.
    req.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);

    await push();
    return reply;
  });

  return app;
}
