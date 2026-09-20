import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import proxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '@ticketing/logger';
import { requestIdPlugin, errorHandlerPlugin, AppError, REQUEST_ID_HEADER } from '@ticketing/http';
import { ErrorCode } from '@ticketing/contracts';
import type { Config } from './config.js';

export type GatewayServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

export interface BuildServerOptions {
  config: Config;
}

export async function buildServer({ config }: BuildServerOptions): Promise<GatewayServer> {
  const app = Fastify({
    loggerInstance: createLogger({ service: 'gateway', level: config.logLevel, pretty: config.nodeEnv === 'development' }),
  });

  // PRD §14 — the gateway is the entry point, so this is where a requestId is
  // minted. Everything downstream reuses it, which is what makes one booking
  // greppable across six services.
  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);

  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    // Rate limiting is edge behaviour and holds no correctness state (ADR-012),
    // so an in-process store is acceptable; Phase 5 moves it to Redis so the
    // limit is shared across gateway replicas rather than per-instance.
    keyGenerator: (req) => req.ip,
  });

  const jwks = createRemoteJWKSet(new URL(config.jwksUri), { cacheMaxAge: 600_000, cooldownDuration: 30_000 });

  /**
   * ADR-010 — **signature only.**
   *
   * The gateway answers exactly one question: "was this token really issued by
   * identity?" It never decides what the caller may do. That decision needs to know
   * what owning a hold or an event means, and only the service that owns the
   * resource knows that.
   *
   * It also never forwards a decision downstream — no `x-user-id`, no
   * `x-user-roles`. Services re-verify the same bearer token themselves, so an
   * attacker reaching a service directly gains nothing by forging a header.
   */
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header === undefined) return;
    if (!header.startsWith('Bearer ')) {
      throw new AppError(401, ErrorCode.unauthorized, 'Authorization header must use the Bearer scheme');
    }

    try {
      await jwtVerify(header.slice('Bearer '.length).trim(), jwks, {
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      });
    } catch (error) {
      req.log.info({ err: error }, 'rejected token at the edge');
      throw new AppError(401, ErrorCode.unauthorized, 'Access token is invalid or expired');
    }
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'gateway' }));

  const upstreams: { prefix: string; target: string; rewritePrefix?: string }[] = [
    // PRD §9.1 — JWKS is published at /identity/.well-known/jwks.json.
    { prefix: '/identity', target: config.identityUrl, rewritePrefix: '' },
    { prefix: '/catalog', target: config.catalogUrl, rewritePrefix: '' },
    // Reservation's routes keep their own names so the seat API reads the same
    // whether it is called through the edge or directly.
    { prefix: '/reservations', target: config.reservationUrl, rewritePrefix: '/reservations' },
    { prefix: '/holds', target: config.reservationUrl, rewritePrefix: '/holds' },
    { prefix: '/availability', target: config.reservationUrl, rewritePrefix: '/availability' },
    // Seat inventory provisioning. Seats are reservation's alone to create, so the
    // route lives here and not under /catalog, which owns only seatmap geometry.
    { prefix: '/inventory', target: config.reservationUrl, rewritePrefix: '/inventory' },
    { prefix: '/orders', target: config.ordersUrl, rewritePrefix: '/orders' },
    { prefix: '/queue', target: config.waitingRoomUrl, rewritePrefix: '/queue' },
  ];

  for (const upstream of upstreams) {
    await app.register(proxy, {
      upstream: upstream.target,
      prefix: upstream.prefix,
      ...(upstream.rewritePrefix === undefined ? {} : { rewritePrefix: upstream.rewritePrefix }),
      // Webhooks and SSE need the body and stream untouched.
      websocket: false,
      replyOptions: {
        rewriteRequestHeaders: (req, headers) => ({
          ...headers,
          // PRD §14 — forward the id on every outbound call, or the trace breaks
          // exactly where it becomes interesting.
          [REQUEST_ID_HEADER]: req.requestId,
          'x-forwarded-for': req.ip,
          'x-forwarded-host': req.headers.host ?? '',
        }),
      },
    });
  }

  return app;
}
