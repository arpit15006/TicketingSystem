import Fastify, { type FastifyInstance, type FastifyRequest, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Pool } from 'pg';
import { createLogger } from '@ticketing/logger';
import {
  requestIdPlugin,
  errorHandlerPlugin,
  authPlugin,
  requirePermission,
  requireAuth,
  AppError,
  type ResourceContext,
} from '@ticketing/http';
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
}

export async function buildServer({ config, pool }: BuildServerOptions): Promise<CatalogServer> {
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
      const { name, address, city } = req.body;
      const inserted = await pool.query(
        `INSERT INTO venues (name, address, city) VALUES ($1, $2, $3) RETURNING venue_id, name, address, city`,
        [name, address, city],
      );
      return reply.status(201).send(inserted.rows[0]);
    },
  );

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

      const inserted = await pool.query(
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
      return reply.status(201).send(inserted.rows[0]);
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
      const rows = status === undefined
        ? await pool.query(
            `SELECT event_id, venue_id, title, status, starts_at, onsale_at, waiting_room_enabled
             FROM events WHERE status IN ('published','onsale') ORDER BY starts_at LIMIT $1`,
            [limit ?? 50],
          )
        : await pool.query(
            `SELECT event_id, venue_id, title, status, starts_at, onsale_at, waiting_room_enabled
             FROM events WHERE status = $1 ORDER BY starts_at LIMIT $2`,
            [status, limit ?? 50],
          );
      return { events: rows.rows };
    },
  );

  app.get('/events/:eventId', { schema: { params: Type.Object({ eventId: UUID }) } }, async (req) => {
    const found = await pool.query(
      `SELECT event_id, venue_id, organizer_id, title, description, status, starts_at, onsale_at,
              waiting_room_enabled, hold_duration_seconds
       FROM events WHERE event_id = $1`,
      [req.params.eventId],
    );
    const event = found.rows[0];
    if (event === undefined) throw new AppError(404, ErrorCode.notFound, 'Event not found');

    const tiers = await pool.query(
      `SELECT tier_id, name, price_paise FROM seat_tiers WHERE event_id = $1 ORDER BY price_paise DESC`,
      [req.params.eventId],
    );
    const sections = await pool.query(
      `SELECT section_id, tier_id, name, row_count, seats_per_row, geometry
       FROM seatmap_sections WHERE event_id = $1 ORDER BY name`,
      [req.params.eventId],
    );

    return { ...event, tiers: tiers.rows, sections: sections.rows };
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
      const inserted = await pool.query(
        `INSERT INTO seat_tiers (event_id, name, price_paise) VALUES ($1, $2, $3)
         RETURNING tier_id, event_id, name, price_paise`,
        [req.params.eventId, req.body.name, req.body.pricePaise],
      );
      return reply.status(201).send(inserted.rows[0]);
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
   */
  app.get('/events/:eventId/seatmap', { schema: { params: Type.Object({ eventId: UUID }) } }, async (req) => {
    const sections = await pool.query(
      `SELECT s.section_id, s.name, s.row_count, s.seats_per_row, s.geometry,
              t.tier_id, t.name AS tier_name, t.price_paise
       FROM seatmap_sections s JOIN seat_tiers t ON t.tier_id = s.tier_id
       WHERE s.event_id = $1 ORDER BY s.name`,
      [req.params.eventId],
    );
    return { eventId: req.params.eventId, sections: sections.rows };
  });

  return app;
}
