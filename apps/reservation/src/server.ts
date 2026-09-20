import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Pool } from 'pg';
import { createLogger, LogEvent } from '@ticketing/logger';
import {
  requestIdPlugin,
  errorHandlerPlugin,
  authPlugin,
  requirePermission,
  requireServiceToken,
  runIdempotent,
  hashRequest,
  IDEMPOTENCY_KEY_HEADER,
  requireUserId,
  seatsUnavailable,
  seatLost,
  holdNotFound,
  holdNotActive,
  AppError,
} from '@ticketing/http';
import { ErrorCode, type HoldResponse } from '@ticketing/contracts';
import type { Config } from './config.js';
import { withTransaction, withDeadlockRetry } from './db.js';
// The allocation operations are now reached through the SeatAllocator (PRD §8.4);
// only the shared availability SQL and hold extension are used directly here.
import { extendHold, AVAILABLE_SEATS_SQL, SALES_SUMMARY_SQL } from './allocation.js';
import { incr, auditInvariants, renderPrometheus, enterAllocation, exitAllocation } from './metrics.js';
import { createAdmissionGuard } from './admission.js';
import { createEventPolicyLoader } from './event-policy.js';
import { allocatorFor, wholeSeatAllocator, segmentAllocator } from './allocator.js';

const UUID = Type.String({ format: 'uuid' });

const CreateReservationBody = Type.Object(
  {
    eventId: UUID,
    // Reserved seating: an explicit basket.
    seatIds: Type.Optional(Type.Array(UUID, { minItems: 1 })),
    // General admission: any N from a tier.
    tierId: Type.Optional(UUID),
    quantity: Type.Optional(Type.Integer({ minimum: 1 })),
    // PRD §8.4 — the journey span. Required when the event is segmented,
    // rejected with 422 when it is whole.
    fromStop: Type.Optional(Type.Integer({ minimum: 0 })),
    toStop: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export interface BuildServerOptions {
  config: Config;
  pool: Pool;
}

/**
 * The full instance type is spelled out rather than inferred: a bare FastifyInstance
 * would erase the TypeBox provider (losing the compile-time link between a route's
 * schema and its handler), while leaving it inferred makes the emitted declaration
 * reference pino through a nested path that does not survive packaging.
 */
export type ReservationServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger,
  TypeBoxTypeProvider
>;

export async function buildServer({ config, pool }: BuildServerOptions): Promise<ReservationServer> {
  const app = Fastify({
    loggerInstance: createLogger({
      service: 'reservation',
      level: config.logLevel,
      pretty: config.nodeEnv === 'development',
    }),
    // The gateway mints request ids (PRD §14); reusing the header keeps one booking
    // under one id across services.
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return (Array.isArray(header) ? header[0] : header) ?? '';
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);

  // ADR-010 — the gateway verifying a signature does not make this service safe.
  // It verifies every token itself, against identity's JWKS.
  await app.register(authPlugin, {
    jwksUri: config.jwksUri,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });

  // Finalization and hold mutation are service-to-service only: a user able to
  // call finalize directly could take a seat without ever paying for it.
  const internalOnly = requireServiceToken(config.internalServiceToken);

  // PRD §12 — waiting-room admission, enforced by the service that owns the seat.
  const enforceAdmission = createAdmissionGuard({ admissionTokenSecret: config.admissionTokenSecret });

  // Catalog owns the event's allocation mode and waiting-room flag; both are
  // fetched together, cached briefly, and fail safe when catalog is unreachable.
  const loadPolicy = createEventPolicyLoader({ catalogUrl: config.catalogUrl });

  /**
   * PRD §8.4 — finalize and release dispatch on the DATA, not on catalog.
   *
   * A hold with rows in `seat_occupancies` was made by the segment allocator;
   * anything else is whole-seat. Deriving it this way keeps finalize — the step
   * that runs after money has been authorized — free of any dependency on
   * catalog being reachable, and means whole-seat finalization is byte-for-byte
   * the Phase 1 path with no added latency.
   */
  const allocatorForHold = async (client: import('pg').PoolClient, holdId: string) => {
    const segmented = await client.query<{ count: string }>(
      `SELECT count(*) FROM seat_occupancies WHERE hold_id = $1`,
      [holdId],
    );
    return Number(segmented.rows[0]?.count ?? 0) > 0 ? segmentAllocator : wholeSeatAllocator;
  };

  interface HoldRow {
    hold_id: string;
    event_id: string;
    user_id: string;
    seat_ids: string[];
    status: string;
    expires_at: Date;
  }

  const HOLD_SQL = `SELECT hold_id, event_id, user_id, seat_ids, status, expires_at FROM holds WHERE hold_id = $1`;

  /** Throws 404 when the hold does not exist, 403 when it is someone else's. */
  const requireHoldOwner = async (
    client: import('pg').PoolClient | Pool,
    holdId: string,
    userId: string,
  ): Promise<HoldRow> => {
    const found = await client.query<HoldRow>(HOLD_SQL, [holdId]);
    const hold = found.rows[0];
    if (hold === undefined) throw holdNotFound(holdId);
    if (hold.user_id !== userId) {
      // Deliberately a 403 and not a 404: the caller already proved they know a
      // real hold id, so pretending it does not exist conceals nothing and makes
      // a legitimate client's bug (stale id after a re-login) much harder to read.
      throw new AppError(403, ErrorCode.forbidden, 'This hold belongs to another user', { holdId });
    }
    return hold;
  };

  /** The wire shape shared by the internal and the owner-scoped hold reads. */
  const describeHold = async (hold: HoldRow) => {
    const seats = await pool.query<{ seat_id: string; tier_id: string; status: string }>(
      `SELECT seat_id, tier_id, status FROM seats WHERE seat_id = ANY($1) ORDER BY seat_id`,
      [hold.seat_ids],
    );
    return {
      holdId: hold.hold_id,
      eventId: hold.event_id,
      userId: hold.user_id,
      status: hold.status,
      expiresAt: hold.expires_at.toISOString(),
      seats: seats.rows.map((row) => ({ seatId: row.seat_id, tierId: row.tier_id, status: row.status })),
    };
  };

  app.get('/healthz', async () => ({ status: 'ok', service: 'reservation' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  /** PRD §6 — INV-1 exposed as a counter an operator or CI job can read. */
  app.get('/metrics', async (_req, reply) => {
    const audit = await auditInvariants(pool);
    return reply.header('content-type', 'text/plain; version=0.0.4').send(renderPrometheus(audit));
  });

  app.get(
    '/availability',
    {
      schema: {
        querystring: Type.Object({
          eventId: UUID,
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
          // PRD §8.4 — "which seats are free for stops 2→5 on this event".
          fromStop: Type.Optional(Type.Integer({ minimum: 0 })),
          toStop: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
      },
    },
    async (req) => {
      const { eventId, limit, fromStop, toStop } = req.query;

      // A span in the query selects the segmented read; its absence keeps the
      // Phase 1 query exactly as it was.
      if (fromStop !== undefined && toStop !== undefined) {
        if (toStop <= fromStop) {
          throw new AppError(422, ErrorCode.validationFailed, 'toStop must be greater than fromStop');
        }
        const client = await pool.connect();
        try {
          const seats = await segmentAllocator.availability(client, {
            eventId,
            limit: limit ?? 500,
            span: { fromStop, toStop },
          });
          return { eventId, fromStop, toStop, available: seats.length, seats };
        } finally {
          client.release();
        }
      }

      const result = await pool.query(AVAILABLE_SEATS_SQL, [eventId, limit ?? 500]);
      return { eventId, available: result.rowCount, seats: result.rows };
    },
  );

  /* ---------------------------------------------------------------- POST /reservations */

  app.post(
    '/reservations',
    {
      schema: { body: CreateReservationBody },
      // PRD §9.2 — holding a seat requires `booking:create`. The check lives here,
      // in the service that owns the seat, not at the edge.
      preHandler: requirePermission('booking:create'),
    },
    async (req, reply) => {
    const userId = requireUserId(req);
    const body = req.body;

    const rawKey = req.headers[IDEMPOTENCY_KEY_HEADER];
    const idempotencyKey = (Array.isArray(rawKey) ? rawKey[0] : rawKey)?.trim() || null;
    const requestHash = hashRequest('POST', '/reservations', body);

    const policy = await loadPolicy(body.eventId, req.requestId);
    const allocator = allocatorFor(policy.allocationMode);

    // PRD §12 — checked before any seat work. Fails open on every infrastructure
    // failure: the waiting room shapes traffic, it does not protect a seat.
    if (config.waitingRoomEnforcementEnabled) {
      await enforceAdmission(req, {
        eventId: body.eventId,
        userId,
        waitingRoomEnabled: policy.waitingRoomEnabled,
      });
    }

    /*
     * PRD §8.4 — the span is required in segmented mode and rejected in whole
     * mode. Silently ignoring a span on a whole-seat event would sell someone a
     * journey they did not get; silently defaulting one on a segmented event
     * would sell them the wrong legs. Both are 422.
     */
    let span: { fromStop: number; toStop: number } | undefined;
    if (allocator.mode === 'segmented') {
      if (body.fromStop === undefined || body.toStop === undefined) {
        throw new AppError(422, ErrorCode.validationFailed, 'This event is segmented; fromStop and toStop are required');
      }
      if (body.toStop <= body.fromStop) {
        throw new AppError(422, ErrorCode.validationFailed, 'toStop must be greater than fromStop');
      }
      span = { fromStop: body.fromStop, toStop: body.toStop };
    } else if (body.fromStop !== undefined || body.toStop !== undefined) {
      throw new AppError(422, ErrorCode.validationFailed, 'This event is not segmented; fromStop and toStop are not accepted');
    }

    enterAllocation();
    try {
      const outcome = await runIdempotent<HoldResponse>(pool, { key: idempotencyKey, userId, requestHash }, async () =>
        // A basket touching several seat rows can deadlock against another basket
        // taking the same rows in a different order. The retry re-evaluates against
        // committed state, so it can only ever produce the same answer more slowly.
        withDeadlockRetry(async () =>
          withTransaction(pool, async (client) => {
            let seatIds: string[];

            if (body.seatIds !== undefined) {
              if (body.seatIds.length > config.maxSeatsPerHold) {
                throw new AppError(422, ErrorCode.validationFailed, `A basket may contain at most ${config.maxSeatsPerHold} seats`);
              }
              // Deterministic order reduces (does not eliminate) lock-order inversions.
              seatIds = [...new Set(body.seatIds)].sort();
            } else if (body.tierId !== undefined && body.quantity !== undefined) {
              if (body.quantity > config.maxSeatsPerHold) {
                throw new AppError(422, ErrorCode.validationFailed, `A basket may contain at most ${config.maxSeatsPerHold} seats`);
              }
              if (allocator.pickGeneralAdmission === undefined) {
                // "Any N from a tier" has no meaning when availability depends
                // on which legs you are travelling.
                throw new AppError(422, ErrorCode.validationFailed, 'General admission is not supported for segmented events');
              }
              seatIds = await allocator.pickGeneralAdmission(client, {
                eventId: body.eventId,
                tierId: body.tierId,
                quantity: body.quantity,
              });
              if (seatIds.length < body.quantity) {
                incr('seat_hold_lost_total');
                req.log.info({ event: LogEvent.seatHoldLost, eventId: body.eventId, tierId: body.tierId }, 'general admission short');
                throw seatsUnavailable([], []);
              }
            } else {
              throw new AppError(422, ErrorCode.validationFailed, 'Provide either seatIds, or tierId and quantity');
            }

            const result = await allocator.acquire({
              client,
              eventId: body.eventId,
              userId,
              seatIds,
              holdSeconds: config.holdDurationSeconds,
              requestId: req.requestId,
              span,
            });

            if ('shortfall' in result) {
              // The seats we failed to claim are exactly those the UPDATE did not
              // return. Re-querying here would read our own uncommitted UPDATE and
              // wrongly report every seat in the basket as unavailable.
              const acquired = new Set(result.acquired);
              const unavailable = seatIds.filter((id) => !acquired.has(id));
              incr('seat_hold_lost_total');
              req.log.info(
                { event: LogEvent.seatHoldLost, eventId: body.eventId, seatIds, unavailable },
                'hold lost: seat taken by a concurrent buyer',
              );
              throw seatsUnavailable(seatIds, unavailable);
            }

            incr('seat_hold_won_total');
            req.log.info({ event: LogEvent.seatHoldWon, holdId: result.holdId, seatIds: result.seatIds }, 'hold won');

            const holdBody: HoldResponse = {
              holdId: result.holdId,
              eventId: body.eventId,
              seatIds: result.seatIds,
              expiresAt: result.expiresAt.toISOString(),
              status: 'active',
            };
            return { statusCode: 201, body: holdBody };
          }),
        ),
      );

      return reply.status(outcome.statusCode).send(outcome.body);
      } finally {
        exitAllocation();
      }
    },
  );

  /* -------------------------------------- POST /inventory/:eventId/seats */

  /**
   * Provision seat inventory for an event.
   *
   * Seats live here and nowhere else: catalog owns the seatmap *geometry* but never
   * writes seat state (PRD §4). So the seatmap is described to this service, and
   * this service creates the rows.
   *
   * Authorization is by explicit `organizer:event:<id>` grant (or platform_admin):
   * reservation has no idea who owns an event — that fact lives in catalog — so it
   * cannot resolve ownership and must not pretend to. Requiring a grant that names
   * the event is the honest check for a service that holds no ownership data.
   */
  app.post(
    '/inventory/:eventId/seats',
    {
      schema: {
        params: Type.Object({ eventId: UUID }),
        body: Type.Object(
          {
            sections: Type.Array(
              Type.Object(
                {
                  name: Type.String({ minLength: 1, maxLength: 50 }),
                  tierId: UUID,
                  rowCount: Type.Integer({ minimum: 1, maximum: 500 }),
                  seatsPerRow: Type.Integer({ minimum: 1, maximum: 500 }),
                },
                { additionalProperties: false },
              ),
              { minItems: 1, maxItems: 50 },
            ),
          },
          { additionalProperties: false },
        ),
      },
      preHandler: requirePermission('event:update', (req) => ({
        resourceId: (req.params as { eventId: string }).eventId,
      })),
    },
    async (req, reply) => {
      const { eventId } = req.params;

      const created = await withTransaction(pool, async (client) => {
        let total = 0;
        for (const section of req.body.sections) {
          // One statement per section rather than a row at a time: 5,000 seats is
          // a cross join in the database, not 5,000 round trips.
          // ON CONFLICT makes re-running the seed harmless.
          const result = await client.query(
            `INSERT INTO seats (event_id, section, row_label, seat_number, tier_id)
             SELECT $1, $2, 'R' || r::text, s::text, $3
             FROM generate_series(1, $4) AS r, generate_series(1, $5) AS s
             ON CONFLICT (event_id, section, row_label, seat_number) DO NOTHING`,
            [eventId, section.name, section.tierId, section.rowCount, section.seatsPerRow],
          );
          total += result.rowCount ?? 0;
        }
        return total;
      });

      const totalSeats = await pool.query<{ count: string }>(
        `SELECT count(*) FROM seats WHERE event_id = $1`,
        [eventId],
      );

      req.log.info({ eventId, created }, 'seats provisioned');
      return reply.status(201).send({ eventId, created, totalSeats: Number(totalSeats.rows[0]?.count) });
    },
  );

  /* ------------------------------------------- GET /inventory/:eventId/sales */

  /**
   * PRD §13 — the organizer dashboard's "live sales".
   *
   * Reservation answers this and not catalog, because seat state lives here and
   * nowhere else (PRD §4, ADR-006). Catalog is allowed to be seconds stale about a
   * seatmap; it is not allowed to hold a second opinion about what is sold.
   *
   * Authorized by an explicit `organizer:event:<id>` grant, exactly as seat
   * provisioning is: this service has no idea who owns an event — that fact is
   * catalog's — so it must not pretend it can resolve ownership.
   */
  app.get(
    '/inventory/:eventId/sales',
    {
      schema: { params: Type.Object({ eventId: UUID }) },
      preHandler: requirePermission('event:update', (req) => ({
        resourceId: (req.params as { eventId: string }).eventId,
      })),
    },
    async (req) => {
      const { eventId } = req.params;
      const result = await pool.query<{ total: number; sold: number; held: number; available: number }>(
        SALES_SUMMARY_SQL,
        [eventId],
      );
      const row = result.rows[0];
      if (row === undefined || row.total === 0) {
        throw new AppError(404, ErrorCode.notFound, 'No seat inventory exists for this event', { eventId });
      }
      return { eventId, ...row };
    },
  );

  /* ------------------------------------------------- DELETE /reservations/:holdId */

  app.delete('/reservations/:holdId', { schema: { params: Type.Object({ holdId: UUID }) } }, async (req, reply) => {
    const userId = requireUserId(req);
    const { holdId } = req.params;

    const result = await withTransaction(pool, async (client) => {
      /*
       * ADR-010 — a hold is an `own`-scoped resource, so the check belongs here.
       *
       * Without it, any authenticated caller who learns a hold id can hand someone
       * else's seats back to the market. That can never oversell — the conditional
       * UPDATE still decides who wins the seat afterwards — but it gives a rival a
       * way to cancel a buyer mid-checkout, which is precisely what the
       * resource-scoped model in PRD §9.2 exists to prevent.
       */
      await requireHoldOwner(client, holdId, userId);

      const allocator = await allocatorForHold(client, holdId);
      return allocator.release(client, { holdId, requestId: req.requestId });
    });

    if (result === null) throw holdNotFound(holdId);
    return reply.status(200).send({ holdId, releasedSeatIds: result.released });
  });

  /* ---------------------------------------- POST /reservations/:holdId/finalize */

  app.post(
    '/reservations/:holdId/finalize',
    {
      schema: { params: Type.Object({ holdId: UUID }), body: Type.Object({ orderId: UUID }, { additionalProperties: false }) },
      preHandler: internalOnly,
    },
    async (req, reply) => {
      const { holdId } = req.params;
      const { orderId } = req.body;

      const result = await withTransaction(pool, async (client) => {
        const allocator = await allocatorForHold(client, holdId);
        const finalize = await allocator.finalize({ client, holdId, orderId, requestId: req.requestId });
        if (finalize.expected === 0) throw holdNotFound(holdId);

        // PRD §8.3 — fewer rows than expected means the seat was lost. Throwing
        // rolls the transaction back, so no partial sale is ever committed, and the
        // orders service reads the 410 as "enter the compensation path" (PRD §10.4).
        if (finalize.finalized.length !== finalize.expected) {
          throw seatLost(holdId, finalize.expected, finalize.finalized.length);
        }
        return finalize;
      }).catch((error: unknown) => {
        if (error instanceof AppError && error.statusCode === 410) {
          incr('seat_finalize_failed_total');
          req.log.warn({ event: LogEvent.seatFinalizeFailed, holdId, orderId }, 'finalize failed: seats lost');
        }
        throw error;
      });

      return reply.status(200).send({ holdId, orderId, soldSeatIds: result.finalized });
    },
  );

  /* ----------------------------------------------------- GET /holds/:holdId */

  /**
   * Internal: the orders service needs a hold's seats, tiers and expiry to price
   * an order and to apply the 90-second rule (PRD §10.1.3). Tier ids are returned
   * rather than prices — pricing belongs to catalog, and reservation must not
   * start holding a second copy of it.
   */
  app.get(
    '/holds/:holdId',
    { schema: { params: Type.Object({ holdId: UUID }) }, preHandler: internalOnly },
    async (req) => {
      const { holdId } = req.params;
      const found = await pool.query<HoldRow>(HOLD_SQL, [holdId]);
      const hold = found.rows[0];
      if (hold === undefined) throw holdNotFound(holdId);
      return describeHold(hold);
    },
  );

  /* ------------------------------------------- GET /reservations/:holdId (owner) */

  /**
   * The same view as above, for the buyer who owns the hold.
   *
   * It exists because `expires_at` is otherwise told to the client exactly once,
   * in the `POST /reservations` response: reload the seat page and the countdown
   * has nothing authoritative to count down to. A client guessing from its own
   * clock would drift, and would keep a dead hold on screen after the server had
   * already let the seats go.
   *
   * Strictly a read of the caller's own resource. Finalization and extension stay
   * `internalOnly` — those move seats and money, and a browser must never reach
   * them (PRD §10.1).
   */
  app.get(
    '/reservations/:holdId',
    { schema: { params: Type.Object({ holdId: UUID }) } },
    async (req) => describeHold(await requireHoldOwner(pool, req.params.holdId, requireUserId(req))),
  );

  /* ------------------------------------------------ PATCH /holds/:holdId/extend */

  app.patch(
    '/holds/:holdId/extend',
    {
      schema: {
        params: Type.Object({ holdId: UUID }),
        body: Type.Object({ seconds: Type.Integer({ minimum: 1, maximum: 3600 }) }, { additionalProperties: false }),
      },
      preHandler: internalOnly,
    },
    async (req, reply) => {
      const { holdId } = req.params;
      const extended = await withTransaction(pool, async (client) =>
        extendHold(client, { holdId, seconds: req.body.seconds }),
      );
      if (extended === null) throw holdNotActive(holdId, 'expired_or_inactive');
      return reply.status(200).send({ holdId, expiresAt: extended.expiresAt.toISOString() });
    },
  );

  return app;
}
