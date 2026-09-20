import Fastify, { type FastifyInstance, type FastifyRequest, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Pool } from 'pg';
import type { Redis } from '@ticketing/http';
import { createLogger } from '@ticketing/logger';
import {
  requestIdPlugin,
  errorHandlerPlugin,
  authPlugin,
  requirePermission,
  requireAuth,
  AppError,
  withRedisFallback,
  withTransaction,
  type ResourceContext,
} from '@ticketing/http';
import { createIdentityClient, type IdentityClient } from './identity-client.js';
import { ErrorCode } from '@ticketing/contracts';
import type { Config } from './config.js';

export type CatalogServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger,
  TypeBoxTypeProvider
>;

const UUID = Type.String({ format: 'uuid' });

export interface BuildServerOptions {
  config: Config;
  pool: Pool;
  /** Optional: seatmap read cache. Absent or broken simply means slower reads. */
  redis?: Redis | null;
  /** Injected by tests; production builds one from config. */
  identity?: IdentityClient;
}

export async function buildServer({ config, pool, redis = null, identity }: BuildServerOptions): Promise<CatalogServer> {
  const identityClient: IdentityClient =
    identity ?? createIdentityClient({ baseUrl: config.identityUrl, serviceToken: config.internalServiceToken });
  const app = Fastify({
    loggerInstance: createLogger({ service: 'catalog', level: config.logLevel, pretty: config.nodeEnv === 'development' }),
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

  /**
   * ADR-010 — catalog resolves ownership itself, because it is the service that
   * knows what owning an event means. The gateway could not answer this question.
   */
  const resolveEventOwner = async (req: FastifyRequest): Promise<ResourceContext> => {
    const { eventId } = req.params as { eventId: string };
    const found = await pool.query<{ organizer_id: string }>(
      `SELECT organizer_id FROM events WHERE event_id = $1`,
      [eventId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new AppError(404, ErrorCode.notFound, 'Event not found');
    return { ownerUserId: row.organizer_id, resourceId: eventId };
  };

  /** seatmap:write is venue-scoped (PRD §9.2), so resolve the event's venue. */
  const resolveEventVenue = async (req: FastifyRequest): Promise<ResourceContext> => {
    const { eventId } = req.params as { eventId: string };
    const found = await pool.query<{ venue_id: string }>(`SELECT venue_id FROM events WHERE event_id = $1`, [eventId]);
    const row = found.rows[0];
    if (row === undefined) throw new AppError(404, ErrorCode.notFound, 'Event not found');
    return { resourceId: row.venue_id };
  };

  app.get('/healthz', async () => ({ status: 'ok', service: 'catalog' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  /**
   * `price_paise` is BIGINT, and node-postgres returns BIGINT as a **string** so
   * that values beyond Number.MAX_SAFE_INTEGER survive the trip. Passed straight
   * through, a client doing arithmetic on it concatenates instead of adding:
   * three Silver seats came out as ₹2,50,00,02,50,00,02,500 rather than ₹7,500.
   *
   * The service that owns the column normalises it, exactly as orders already
   * does for `amount_paise` — otherwise every client has to rediscover this, and
   * TypeScript cannot help because the value is unvalidated JSON on the wire.
   *
   * A ticket price is nowhere near the safe-integer ceiling (₹90 trillion), so
   * Number is lossless here.
   */
  const asPricedTier = <T extends { price_paise: string | number }>(
    row: T,
  ): Omit<T, 'price_paise'> & { price_paise: number } => ({
    ...row,
    price_paise: Number(row.price_paise),
  });

  interface ListedEventRow {
    event_id: string;
    venue_id: string;
    organizer_id: string;
    title: string;
    status: string;
    starts_at: Date;
    onsale_at: Date | null;
    waiting_room_enabled: boolean;
    venue_name: string;
    venue_city: string;
    /** BIGINT → string on the wire; normalised in asListedEvent. Null with no tiers. */
    min_price_paise: string | null;
  }

  const LIST_EVENTS_SQL = `
    SELECT e.event_id, e.venue_id, e.organizer_id, e.title, e.status, e.starts_at, e.onsale_at,
           e.waiting_room_enabled,
           v.name AS venue_name, v.city AS venue_city,
           (SELECT min(t.price_paise) FROM seat_tiers t WHERE t.event_id = e.event_id) AS min_price_paise
    FROM events e
    JOIN venues v ON v.venue_id = e.venue_id`;

  const asListedEvent = (row: ListedEventRow) => ({
    ...row,
    min_price_paise: row.min_price_paise === null ? null : Number(row.min_price_paise),
  });

  /* --------------------------------------------------------------- venues */

  app.post(
    '/venues',
    {
      schema: {
        body: Type.Object(
          { name: Type.String({ minLength: 1 }), address: Type.String({ minLength: 1 }), city: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
      },
      preHandler: requirePermission('venue:create'),
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { name, address, city } = req.body;

      /*
       * The creator becomes `venue_admin` of the venue they just made, or the
       * venue is not made at all. Seatmap sections are venue-scoped (PRD §9.2),
       * so without the grant the person who created the venue cannot lay out a
       * single seat in it. The grant is requested inside the transaction: if
       * identity refuses or is down, the INSERT rolls back and the caller gets
       * an error rather than a venue they cannot use.
       */
      const venue = await withTransaction(pool, async (client) => {
        const inserted = await client.query<{ venue_id: string; name: string; address: string; city: string }>(
          `INSERT INTO venues (name, address, city) VALUES ($1, $2, $3) RETURNING venue_id, name, address, city`,
          [name, address, city],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('venue insert returned no row');
        await identityClient.grant(
          { userId: auth.userId, role: 'venue_admin', resourceType: 'venue', resourceId: row.venue_id },
          req.requestId,
        );
        return row;
      });
      return reply.status(201).send(venue);
    },
  );

  /** Every venue. Public, like the events that reference them. */
  app.get('/venues', async () => {
    const rows = await pool.query(`SELECT venue_id, name, address, city FROM venues ORDER BY city, name`);
    return { venues: rows.rows };
  });

  app.get('/venues/:venueId', { schema: { params: Type.Object({ venueId: UUID }) } }, async (req) => {
    const found = await pool.query(`SELECT venue_id, name, address, city FROM venues WHERE venue_id = $1`, [
      req.params.venueId,
    ]);
    const row = found.rows[0];
    if (row === undefined) throw new AppError(404, ErrorCode.notFound, 'Venue not found');
    return row;
  });

  /* --------------------------------------------------------------- events */

  app.post(
    '/events',
    {
      schema: {
        body: Type.Object(
          {
            venueId: UUID,
            title: Type.String({ minLength: 1, maxLength: 300 }),
            description: Type.Optional(Type.String({ maxLength: 5000 })),
            startsAt: Type.String({ format: 'date-time' }),
            onsaleAt: Type.Optional(Type.String({ format: 'date-time' })),
            waitingRoomEnabled: Type.Optional(Type.Boolean()),
            holdDurationSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 3600 })),
          },
          { additionalProperties: false },
        ),
      },
      preHandler: requirePermission('event:create'),
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const body = req.body;

      /*
       * The creator becomes `organizer` of this specific event, in the same
       * transaction. Catalog can check ownership from `organizer_id` itself, but
       * reservation cannot see this table (ADR-004) and authorizes seat
       * provisioning by an explicit `organizer:event:<id>` grant — so an event
       * with no grant is an event whose organizer cannot put seats on sale.
       */
      const event = await withTransaction(pool, async (client) => {
        const inserted = await client.query<{ event_id: string }>(
          `INSERT INTO events (venue_id, organizer_id, title, description, starts_at, onsale_at, waiting_room_enabled, hold_duration_seconds)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING event_id, venue_id, organizer_id, title, description, status, starts_at, onsale_at,
                     waiting_room_enabled, hold_duration_seconds`,
          [
            body.venueId,
            auth.userId,
            body.title,
            body.description ?? '',
            body.startsAt,
            body.onsaleAt ?? null,
            body.waitingRoomEnabled ?? false,
            body.holdDurationSeconds ?? 480,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('event insert returned no row');
        await identityClient.grant(
          { userId: auth.userId, role: 'organizer', resourceType: 'event', resourceId: row.event_id },
          req.requestId,
        );
        return row;
      });
      return reply.status(201).send(event);
    },
  );

  /** Public browse. Drafts belong to their organizer and are not listed. */
  app.get(
    '/events',
    {
      schema: {
        querystring: Type.Object({
          status: Type.Optional(Type.Union([Type.Literal('published'), Type.Literal('onsale'), Type.Literal('closed')])),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
      },
    },
    async (req) => {
      const { status, limit } = req.query;
      // A listing card needs the venue and an entry price without N+1 detail
      // calls. Both are catalog's own tables, so one query answers it.
      const rows = status === undefined
        ? await pool.query<ListedEventRow>(
            `${LIST_EVENTS_SQL} WHERE e.status IN ('published','onsale') ORDER BY e.starts_at LIMIT $1`,
            [limit ?? 50],
          )
        : await pool.query<ListedEventRow>(
            `${LIST_EVENTS_SQL} WHERE e.status = $1 ORDER BY e.starts_at LIMIT $2`,
            [status, limit ?? 50],
          );
      return { events: rows.rows.map(asListedEvent) };
    },
  );

  /**
   * The organizer dashboard. Drafts are invisible to the public listing by
   * design, so an organizer needs a view of their own events that includes them.
   * Ownership is `organizer_id`, a fact this service holds; a co-organizer
   * holding an `organizer:event:<id>` grant sees those events too.
   */
  app.get('/events/mine', async (req) => {
    const auth = requireAuth(req);
    const granted = auth.roles
      .filter((g) => g.role === 'organizer' && g.resourceType === 'event' && g.resourceId !== null)
      .map((g) => g.resourceId as string);
    const rows = await pool.query<ListedEventRow>(
      `${LIST_EVENTS_SQL} WHERE e.organizer_id = $1 OR e.event_id = ANY($2::uuid[]) ORDER BY e.starts_at DESC LIMIT 200`,
      [auth.userId, granted],
    );
    return { events: rows.rows.map(asListedEvent) };
  });

  app.get('/events/:eventId', { schema: { params: Type.Object({ eventId: UUID }) } }, async (req) => {
    const found = await pool.query(
      `SELECT event_id, venue_id, organizer_id, title, description, status, starts_at, onsale_at,
              waiting_room_enabled, hold_duration_seconds
       FROM events WHERE event_id = $1`,
      [req.params.eventId],
    );
    const event = found.rows[0];
    if (event === undefined) throw new AppError(404, ErrorCode.notFound, 'Event not found');

    const tiers = await pool.query<{ tier_id: string; name: string; price_paise: string }>(
      `SELECT tier_id, name, price_paise FROM seat_tiers WHERE event_id = $1 ORDER BY price_paise DESC`,
      [req.params.eventId],
    );
    const sections = await pool.query(
      `SELECT section_id, tier_id, name, row_count, seats_per_row, geometry
       FROM seatmap_sections WHERE event_id = $1 ORDER BY name`,
      [req.params.eventId],
    );

    return { ...event, tiers: tiers.rows.map(asPricedTier), sections: sections.rows };
  });

  app.patch(
    '/events/:eventId',
    {
      schema: {
        params: Type.Object({ eventId: UUID }),
        body: Type.Object(
          {
            title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
            description: Type.Optional(Type.String({ maxLength: 5000 })),
            startsAt: Type.Optional(Type.String({ format: 'date-time' })),
            onsaleAt: Type.Optional(Type.String({ format: 'date-time' })),
            waitingRoomEnabled: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
      preHandler: requirePermission('event:update', resolveEventOwner),
    },
    async (req) => {
      const b = req.body;
      const updated = await pool.query(
        `UPDATE events SET
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           starts_at = COALESCE($4, starts_at),
           onsale_at = COALESCE($5, onsale_at),
           waiting_room_enabled = COALESCE($6, waiting_room_enabled),
           updated_at = now()
         WHERE event_id = $1
         RETURNING event_id, title, description, status, starts_at, onsale_at, waiting_room_enabled`,
        [req.params.eventId, b.title ?? null, b.description ?? null, b.startsAt ?? null, b.onsaleAt ?? null, b.waitingRoomEnabled ?? null],
      );
      return updated.rows[0];
    },
  );

  app.post(
    '/events/:eventId/publish',
    {
      schema: {
        params: Type.Object({ eventId: UUID }),
        body: Type.Optional(Type.Object({ onsale: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
      },
      preHandler: requirePermission('event:publish', resolveEventOwner),
    },
    async (req) => {
      const target = req.body?.onsale === true ? 'onsale' : 'published';

      // An event with no tiers has no prices, so publishing it would put a
      // seatmap on sale that nobody can buy from.
      const tiers = await pool.query<{ count: string }>(`SELECT count(*) FROM seat_tiers WHERE event_id = $1`, [
        req.params.eventId,
      ]);
      if (Number(tiers.rows[0]?.count) === 0) {
        throw new AppError(422, ErrorCode.validationFailed, 'An event needs at least one pricing tier before it can be published');
      }

      const updated = await pool.query(
        `UPDATE events SET status = $2, updated_at = now() WHERE event_id = $1
         RETURNING event_id, status, onsale_at`,
        [req.params.eventId, target],
      );
      return updated.rows[0];
    },
  );

  /* ------------------------------------------------------------- scanners */

  /**
   * "Hire a scanner for my event." PRD §9.2 scopes `scanner` to "events assigned
   * to them"; this is where an organizer does the assigning. Catalog checks the
   * caller owns the event (it holds `organizer_id`), then asks identity to turn
   * the email into a user and record the scoped grant — the same service-auth
   * handoff creation uses. Catalog never touches identity's tables.
   */
  app.post(
    '/events/:eventId/scanners',
    {
      schema: {
        params: Type.Object({ eventId: UUID }),
        body: Type.Object({ email: Type.String({ format: 'email', maxLength: 320 }) }, { additionalProperties: false }),
      },
      preHandler: requirePermission('event:update', resolveEventOwner),
    },
    async (req, reply) => {
      const user = await identityClient.findByEmail(req.body.email, req.requestId);
      if (user === null) throw new AppError(404, ErrorCode.notFound, 'No account with that email — they need to register first');
      await identityClient.grant(
        { userId: user.userId, role: 'scanner', resourceType: 'event', resourceId: req.params.eventId },
        req.requestId,
      );
      req.log.info({ eventId: req.params.eventId, scanner: user.userId }, 'scanner assigned');
      return reply.status(201).send({ userId: user.userId, email: user.email, fullName: user.fullName, eventId: req.params.eventId });
    },
  );

  /* ---------------------------------------------------------------- tiers */

  app.post(
    '/events/:eventId/tiers',
    {
      schema: {
        params: Type.Object({ eventId: UUID }),
        body: Type.Object(
          { name: Type.String({ minLength: 1 }), pricePaise: Type.Integer({ minimum: 0 }) },
          { additionalProperties: false },
        ),
      },
      preHandler: requirePermission('event:update', resolveEventOwner),
    },
    async (req, reply) => {
      const inserted = await pool.query<{ tier_id: string; event_id: string; name: string; price_paise: string }>(
        `INSERT INTO seat_tiers (event_id, name, price_paise) VALUES ($1, $2, $3)
         RETURNING tier_id, event_id, name, price_paise`,
        [req.params.eventId, req.body.name, req.body.pricePaise],
      );
      const tier = inserted.rows[0];
      if (tier === undefined) throw new Error('tier insert returned no row');
      return reply.status(201).send(asPricedTier(tier));
    },
  );

  /* -------------------------------------------------------------- seatmap */

  app.post(
    '/events/:eventId/sections',
    {
      schema: {
        params: Type.Object({ eventId: UUID }),
        body: Type.Object(
          {
            tierId: UUID,
            name: Type.String({ minLength: 1 }),
            rowCount: Type.Integer({ minimum: 1, maximum: 500 }),
            seatsPerRow: Type.Integer({ minimum: 1, maximum: 500 }),
            geometry: Type.Optional(Type.Object({}, { additionalProperties: true })),
          },
          { additionalProperties: false },
        ),
      },
      // Venue-scoped, per PRD §9.2: seatmaps belong to the venue, not the event.
      preHandler: requirePermission('seatmap:write', resolveEventVenue),
    },
    async (req, reply) => {
      const b = req.body;
      const inserted = await pool.query(
        `INSERT INTO seatmap_sections (event_id, tier_id, name, row_count, seats_per_row, geometry)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING section_id, event_id, tier_id, name, row_count, seats_per_row, geometry`,
        [req.params.eventId, b.tierId, b.name, b.rowCount, b.seatsPerRow, JSON.stringify(b.geometry ?? {})],
      );
      return reply.status(201).send(inserted.rows[0]);
    },
  );

  /**
   * The seatmap geometry only. Availability is deliberately NOT here: catalog never
   * reads or reports seat state (PRD §4, ADR-006). A client asks reservation for
   * that, because a seatmap may be seconds stale and an allocation may not.
   *
   * Cached in Redis for a few seconds because this is the highest-volume read in
   * the system — and cached ONLY because nothing here affects who gets a seat.
   *
   * ADR-012 — every Redis interaction below is wrapped so that a cache failure
   * degrades latency and nothing else. If Redis is gone, this endpoint falls back
   * to Postgres and keeps serving. A seatmap that is slower is not an outage; a
   * seatmap that 500s is.
   */
  app.get('/events/:eventId/seatmap', { schema: { params: Type.Object({ eventId: UUID }) } }, async (req, reply) => {
    const { eventId } = req.params;
    const cacheKey = `catalog:seatmap:${eventId}`;

    if (redis !== null) {
      const cached = await withRedisFallback(async () => redis.get(cacheKey), null);
      if (cached !== null) {
        return reply.header('x-cache', 'hit').send(JSON.parse(cached) as unknown);
      }
    }

    const sections = await pool.query<{ price_paise: string }>(
      `SELECT s.section_id, s.name, s.row_count, s.seats_per_row, s.geometry,
              t.tier_id, t.name AS tier_name, t.price_paise
       FROM seatmap_sections s JOIN seat_tiers t ON t.tier_id = s.tier_id
       WHERE s.event_id = $1 ORDER BY s.name`,
      [eventId],
    );
    // Normalised BEFORE caching, or the cache would serve the string form for
    // its whole TTL and the bug would look intermittent.
    const body = { eventId, sections: sections.rows.map(asPricedTier) };

    if (redis !== null) {
      await withRedisFallback(
        async () => redis.set(cacheKey, JSON.stringify(body), 'EX', config.seatmapCacheTtlSeconds),
        null,
      );
    }

    // `x-cache: miss` when Redis served nothing — including when it is down, which
    // is exactly what the chaos test asserts.
    return reply.header('x-cache', 'miss').send(body);
  });

  return app;
}
