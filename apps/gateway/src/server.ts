import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import proxy from '@fastify/http-proxy';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createRedisClient } from '@ticketing/http';
import { createLogger } from '@ticketing/logger';
import { requestIdPlugin, errorHandlerPlugin, AppError, REQUEST_ID_HEADER, IDEMPOTENCY_KEY_HEADER } from '@ticketing/http';
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

  /*
   * PRD §13 — the browser talks only to the gateway, so this is the platform's
   * entire CORS surface.
   *
   * Registered BEFORE the rate limiter and both auth hooks, deliberately. A
   * preflight `OPTIONS` carries no `Authorization` header and no credentials, so
   * letting it reach those hooks would spend rate-limit quota on a request that
   * can never book anything — and would answer a browser's "may I?" with a 429.
   *
   * `allowedHeaders` is explicit rather than reflective. Every header the client
   * legitimately sends is a header some service reads: omitting `idempotency-key`
   * silently disables duplicate-request protection in the browser, which is the
   * one place duplicate requests actually happen (double-tapped checkout).
   */
  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      IDEMPOTENCY_KEY_HEADER,
      'x-admission-token',
      REQUEST_ID_HEADER,
      'last-event-id',
    ],
    // So a browser can read the id out of a failed response and quote it in a bug
    // report — the whole point of PRD §14's end-to-end request id.
    exposedHeaders: [REQUEST_ID_HEADER, 'retry-after'],
    // Bearer tokens, not cookies. Nothing here needs ambient credentials, and
    // allowing them would widen the blast radius of a mistaken origin entry.
    credentials: false,
    maxAge: 600,
  });

  /*
   * ADR-012 — rate limiting is edge behaviour and holds no correctness state.
   *
   * Redis makes the limit shared across gateway replicas instead of per-instance;
   * without it, N replicas quietly allow N times the configured rate. When Redis
   * is unavailable the plugin falls back to its in-process store, which is a
   * looser limit rather than a closed door — the correct trade for a component
   * that protects nothing (INV-7).
   */
  const rateLimitRedis = config.redisUrl === '' ? null : createRedisClient({ url: config.redisUrl });

  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    ...(rateLimitRedis === null ? {} : { redis: rateLimitRedis }),
    keyGenerator: (req) => req.ip,
    /*
     * FAIL OPEN when the store errors.
     *
     * This defaults to FALSE, which turns any Redis hiccup into a 500 on every
     * request at the edge — the exact opposite of ADR-012's promise, and worse
     * than having no rate limiter at all. With `enableOfflineQueue: false` that
     * includes the window while the connection is still being established.
     *
     * An unthrottled request reaches a seat allocator that is correct under any
     * load (INV-7); a 500 reaches a customer who cannot buy a ticket.
     */
    skipOnError: true,
  });

  app.addHook('onClose', async () => {
    rateLimitRedis?.disconnect();
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

  /*
   * PRD §12 — waiting-room enforcement at the edge.
   *
   * The gateway rejects an admission token that is malformed, expired or forged.
   * It does NOT decide whether one was required: that depends on the event, which
   * is in the request body, and a check the client can dodge by reaching the
   * service directly is not a check. Reservation makes the authoritative decision
   * (ADR-010); this is the cheap early filter in front of it.
   */
  const admissionSecret = new TextEncoder().encode(config.admissionTokenSecret);

  app.addHook('onRequest', async (req) => {
    const raw = req.headers['x-admission-token'];
    const token = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (token === undefined || token === '') return;

    try {
      await jwtVerify(token, admissionSecret, { issuer: 'waitingroom', audience: 'ticketing' });
    } catch {
      req.log.info('rejected an invalid admission token at the edge');
      throw new AppError(403, ErrorCode.forbidden, 'Admission token is invalid or expired');
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
    // The gate scanner. Orders owns tickets, so this is orders — it simply does not
    // belong under /orders, because scanning is not an operation on an order.
    { prefix: '/tickets', target: config.ordersUrl, rewritePrefix: '/tickets' },
    { prefix: '/queue', target: config.waitingRoomUrl, rewritePrefix: '/queue' },
    // Read-only delivery log. Without this entry the notification service has no
    // route to a browser at all, and the compensation message it records is
    // written for a user who can never see it.
    { prefix: '/notifications', target: config.notificationUrl, rewritePrefix: '/notifications' },
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
