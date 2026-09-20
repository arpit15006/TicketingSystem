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
import {
  acquireHold,
  finalizeHold,
  releaseHold,
  extendHold,
  pickGeneralAdmissionSeats,
  AVAILABLE_SEATS_SQL,
} from './allocation.js';
import { incr, auditInvariants, renderPrometheus, enterAllocation, exitAllocation } from './metrics.js';

const UUID = Type.String({ format: 'uuid' });

const CreateReservationBody = Type.Object(
  {
    eventId: UUID,
    // Reserved seating: an explicit basket.
    seatIds: Type.Optional(Type.Array(UUID, { minItems: 1 })),
    // General admission: any N from a tier.
    tierId: Type.Optional(UUID),
    quantity: Type.Optional(Type.Integer({ minimum: 1 })),
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
    { schema: { querystring: Type.Object({ eventId: UUID, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) }) } },
    async (req) => {
      const { eventId, limit } = req.query;
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
              seatIds = await pickGeneralAdmissionSeats(client, {
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

            const result = await acquireHold({
              client,
              eventId: body.eventId,
              userId,
              seatIds,
              holdSeconds: config.holdDurationSeconds,
              requestId: req.requestId,
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

  /* ------------------------------------------------- DELETE /reservations/:holdId */

  app.delete('/reservations/:holdId', { schema: { params: Type.Object({ holdId: UUID }) } }, async (req, reply) => {
    requireUserId(req);
    const { holdId } = req.params;

    const result = await withTransaction(pool, async (client) =>
      releaseHold(client, { holdId, requestId: req.requestId }),
    );

    if (result === null) throw holdNotFound(holdId);
    return reply.status(200).send({ holdId, releasedSeatIds: result.released });
  });

  /* ---------------------------------------- POST /reservations/:holdId/finalize */

  app.post(
    '/reservations/:holdId/finalize',
    { schema: { params: Type.Object({ holdId: UUID }), body: Type.Object({ orderId: UUID }, { additionalProperties: false }) } },
    async (req, reply) => {
      const { holdId } = req.params;
      const { orderId } = req.body;

      const result = await withTransaction(pool, async (client) => {
        const finalize = await finalizeHold({ client, holdId, orderId, requestId: req.requestId });
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

  /* ------------------------------------------------ PATCH /holds/:holdId/extend */

  app.patch(
    '/holds/:holdId/extend',
    {
      schema: {
        params: Type.Object({ holdId: UUID }),
        body: Type.Object({ seconds: Type.Integer({ minimum: 1, maximum: 3600 }) }, { additionalProperties: false }),
      },
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
