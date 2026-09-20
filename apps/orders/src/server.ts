import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
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
  runIdempotent,
  hashRequest,
  IDEMPOTENCY_KEY_HEADER,
  AppError,
  PgError,
  pgErrorCode,
} from '@ticketing/http';
import { ErrorCode } from '@ticketing/contracts';
import type { Config } from './config.js';
import type { RazorpayClient } from './razorpay.js';
import type { CatalogClient, ReservationClient } from './clients.js';
import { findOrder, settleOrder, type OrderRow, type SettleDeps } from './orders.js';
import { verifyCheckoutSignature } from './signatures.js';
import { webhookPlugin } from './webhook.js';

export type OrdersServer = FastifyInstance<
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
  razorpay: RazorpayClient;
  reservation: ReservationClient;
  catalog: CatalogClient;
}

export async function buildServer(options: BuildServerOptions): Promise<OrdersServer> {
  const { config, pool, razorpay, reservation, catalog } = options;

  const app = Fastify({
    loggerInstance: createLogger({ service: 'orders', level: config.logLevel, pretty: config.nodeEnv === 'development' }),
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

  const settleDeps = (log: SettleDeps['log']): SettleDeps => ({
    pool,
    razorpay,
    reservation,
    currency: config.currency,
    log,
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'orders' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  /*
   * The webhook lives in its own plugin scope so that its raw-buffer content-type
   * parser applies to nothing else. Registered before the JSON routes below to make
   * that separation obvious when reading the file.
   */
  await app.register(webhookPlugin, {
    prefix: '/orders',
    pool,
    webhookSecret: config.razorpayWebhookSecret,
    settleDeps: settleDeps(app.log),
  });

  /* ------------------------------------------------------------ POST /orders */

  app.post(
    '/orders',
    {
      schema: { body: Type.Object({ holdId: UUID }, { additionalProperties: false }) },
      preHandler: requirePermission('booking:create'),
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const { holdId } = req.body;

      const rawKey = req.headers[IDEMPOTENCY_KEY_HEADER];
      const idempotencyKey = (Array.isArray(rawKey) ? rawKey[0] : rawKey)?.trim() || null;
      const requestHash = hashRequest('POST', '/orders', req.body);

      const outcome = await runIdempotent(pool, { key: idempotencyKey, userId: auth.userId, requestHash }, async () => {
        const hold = await reservation.getHold(holdId, req.requestId);
        if (hold === null) throw new AppError(404, ErrorCode.holdNotFound, 'Hold not found', { holdId });

        // Buying someone else's hold is the obvious attack; the check belongs here,
        // in the service that owns the order (ADR-010).
        if (hold.userId !== auth.userId) {
          throw new AppError(403, ErrorCode.forbidden, 'This hold belongs to another user');
        }
        if (hold.status !== 'active') {
          throw new AppError(409, ErrorCode.holdNotActive, 'Hold is no longer active', { status: hold.status });
        }

        /*
         * PRD §10.1.3 / ADR-008 — refuse to start a payment when the hold is
         * nearly gone.
         *
         * This is the first of the three mechanisms that bound the
         * payment-after-expiry race. It cannot eliminate it — that would need a
         * transaction spanning our database and Razorpay's — so it shrinks the
         * window instead, and the compensation path handles what is left.
         */
        const secondsRemaining = (new Date(hold.expiresAt).getTime() - Date.now()) / 1000;
        if (secondsRemaining < config.minHoldSecondsForOrder) {
          throw new AppError(
            409,
            ErrorCode.holdNotActive,
            `Less than ${config.minHoldSecondsForOrder}s of hold remains; re-acquire the seats before paying`,
            { secondsRemaining: Math.floor(secondsRemaining) },
          );
        }

        const prices = await catalog.getTierPrices(hold.eventId, req.requestId);
        let amountPaise = 0;
        for (const seat of hold.seats) {
          const price = prices.get(seat.tierId);
          if (price === undefined) {
            throw new AppError(422, ErrorCode.validationFailed, 'A seat has no price in this event', {
              seatId: seat.seatId,
            });
          }
          amountPaise += price;
        }

        // PRD §10.1.4 — extend the hold before taking payment, so checkout has room.
        await reservation.extendHold(holdId, config.holdExtensionSeconds, req.requestId);

        let order: OrderRow;
        try {
          const inserted = await pool.query<OrderRow>(
            `INSERT INTO orders (user_id, event_id, hold_id, seat_ids, amount_paise, status)
             VALUES ($1, $2, $3, $4, $5, 'created')
             RETURNING *`,
            [auth.userId, hold.eventId, holdId, hold.seats.map((s) => s.seatId), amountPaise],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error('order insert returned no row');
          order = row;
        } catch (error) {
          if (pgErrorCode(error) === PgError.uniqueViolation) {
            // orders_one_live_per_hold — a double-tapped checkout.
            throw new AppError(409, ErrorCode.conflict, 'An order already exists for this hold', { holdId });
          }
          throw error;
        }

        // ADR-007 — payment_capture: 0. Authorize now, capture only after the seat
        // is actually ours.
        const razorpayOrder = await razorpay.createOrder({
          amountPaise,
          currency: config.currency,
          receipt: order.order_id,
          notes: { orderId: order.order_id, eventId: hold.eventId },
        });

        await pool.query(
          `UPDATE orders SET razorpay_order_id = $2, status = 'awaiting_payment', updated_at = now()
           WHERE order_id = $1`,
          [order.order_id, razorpayOrder.id],
        );

        req.log.info({ orderId: order.order_id, amountPaise, holdId }, 'order created');

        return {
          statusCode: 201,
          body: {
            orderId: order.order_id,
            holdId,
            eventId: hold.eventId,
            seatIds: order.seat_ids,
            amountPaise,
            currency: config.currency,
            status: 'awaiting_payment',
            razorpayOrderId: razorpayOrder.id,
            // The publishable key id. The secret never leaves this service.
            razorpayKeyId: config.razorpayKeyId,
          },
        };
      });

      return reply.status(outcome.statusCode).send(outcome.body);
    },
  );

  /* ---------------------------------------------------- POST /orders/:id/verify */

  app.post(
    '/orders/:orderId/verify',
    {
      schema: {
        params: Type.Object({ orderId: UUID }),
        body: Type.Object(
          {
            razorpayOrderId: Type.String({ minLength: 1 }),
            razorpayPaymentId: Type.String({ minLength: 1 }),
            razorpaySignature: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      },
      preHandler: requirePermission('booking:create'),
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const order = await findOrder(pool, req.params.orderId);

      if (order === null) throw new AppError(404, ErrorCode.notFound, 'Order not found');
      if (order.user_id !== auth.userId) {
        throw new AppError(403, ErrorCode.forbidden, 'This order belongs to another user');
      }

      /*
       * PRD §10.1.7 — never trust the client's success callback.
       *
       * The browser telling us "payment succeeded" is an assertion by an
       * untrusted party. Only the HMAC, computed with a secret the client does
       * not have, makes it evidence.
       */
      const signatureValid = verifyCheckoutSignature({
        razorpayOrderId: req.body.razorpayOrderId,
        razorpayPaymentId: req.body.razorpayPaymentId,
        signature: req.body.razorpaySignature,
        keySecret: config.razorpayKeySecret,
      });

      if (!signatureValid || req.body.razorpayOrderId !== order.razorpay_order_id) {
        req.log.warn({ orderId: order.order_id }, 'checkout signature verification failed');
        throw new AppError(400, ErrorCode.validationFailed, 'Payment signature verification failed');
      }

      const result = await settleOrder(settleDeps(req.log), {
        order,
        paymentId: req.body.razorpayPaymentId,
        requestId: req.requestId,
      });

      const current = await findOrder(pool, order.order_id);

      if (result.kind === 'compensated') {
        // PRD §10.4 — 200, not an error: the request was handled correctly and the
        // user needs to be told clearly what happened to their money and their seat.
        return reply.status(200).send({
          orderId: order.order_id,
          status: current?.status ?? 'refunded_seat_lost',
          compensated: true,
          reason: result.reason,
          message:
            'Your payment was released and not charged. The seats were taken while the payment was being confirmed. Please choose alternative seats.',
        });
      }

      if (result.kind === 'terminal') {
        return reply.status(409).send({ orderId: order.order_id, status: result.status });
      }

      return reply.status(200).send({
        orderId: order.order_id,
        status: current?.status ?? 'confirmed',
        ticketIds: result.ticketIds,
        seatIds: order.seat_ids,
      });
    },
  );

  /* ---------------------------------------------------------- POST /tickets/scan */

  /**
   * PRD §13 `/scan` — the gate scanner.
   *
   * Two properties matter here, and they are the same two that matter for a seat:
   *
   *  1. **Idempotent.** A scanner at a turnstile re-reads codes constantly, and a
   *     flaky network makes the client retry. A second scan of a real ticket is a
   *     normal event, not an error — it answers `alreadyScanned` with the original
   *     timestamp and returns 200.
   *
   *  2. **Race-safe.** `scanned_at IS NULL` in the WHERE clause makes the UPDATE
   *     itself the arbiter, exactly as `ACQUIRE_HOLD_SQL` does for seats (ADR-002).
   *     Two turnstiles scanning one forwarded screenshot at the same instant:
   *     exactly one row comes back, so exactly one gate opens. Reading first and
   *     writing second would let both in.
   */
  app.post(
    '/tickets/scan',
    {
      schema: {
        body: Type.Object({ qrToken: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
      },
      /*
       * PRD §9.2 — `ticket:scan` is scoped to the event, so a scanner hired for one
       * show cannot wave people into another. The event is resolved from the ticket
       * itself; an unknown code resolves to nothing and is refused before the
       * handler runs, which also means an unauthorized caller cannot use this route
       * to probe whether a code is real.
       */
      preHandler: requirePermission('ticket:scan', async (req) => {
        const { qrToken } = req.body as { qrToken: string };
        const found = await pool.query<{ event_id: string }>(
          `SELECT o.event_id FROM tickets t JOIN orders o ON o.order_id = t.order_id WHERE t.qr_token = $1`,
          [qrToken],
        );
        return { resourceId: found.rows[0]?.event_id };
      }),
    },
    async (req, reply) => {
      const { qrToken } = req.body;

      const found = await pool.query<{
        ticket_id: string;
        seat_id: string;
        scanned_at: Date | null;
        event_id: string;
        order_status: string;
      }>(
        `SELECT t.ticket_id, t.seat_id, t.scanned_at, o.event_id, o.status AS order_status
         FROM tickets t JOIN orders o ON o.order_id = t.order_id
         WHERE t.qr_token = $1`,
        [qrToken],
      );

      const ticket = found.rows[0];
      if (ticket === undefined) throw new AppError(404, ErrorCode.notFound, 'No ticket matches that code');

      /*
       * A ticket row only ever exists for a confirmed order — it is written in the
       * same transaction that confirms one (§10.1.10). This check is therefore
       * defence in depth against a future path that issues one earlier, and it is
       * cheap enough to keep.
       */
      if (ticket.order_status !== 'confirmed') {
        throw new AppError(409, ErrorCode.conflict, 'That ticket is not valid for entry', {
          orderStatus: ticket.order_status,
        });
      }

      const claimed = await pool.query<{ scanned_at: Date }>(
        `UPDATE tickets SET scanned_at = now() WHERE ticket_id = $1 AND scanned_at IS NULL RETURNING scanned_at`,
        [ticket.ticket_id],
      );

      const admitted = claimed.rows[0];
      const scannedAt = admitted?.scanned_at ?? ticket.scanned_at;

      req.log.info(
        { ticketId: ticket.ticket_id, eventId: ticket.event_id, admitted: admitted !== undefined },
        admitted === undefined ? 'ticket already scanned' : 'ticket scanned',
      );

      return reply.status(200).send({
        ticketId: ticket.ticket_id,
        eventId: ticket.event_id,
        seatId: ticket.seat_id,
        admitted: admitted !== undefined,
        alreadyScanned: admitted === undefined,
        scannedAt: scannedAt === null ? null : scannedAt.toISOString(),
      });
    },
  );

  /* ------------------------------------------------------- GET /orders/:orderId */

  app.get('/orders/:orderId', { schema: { params: Type.Object({ orderId: UUID }) } }, async (req) => {
    const auth = requireAuth(req);
    const order = await findOrder(pool, req.params.orderId);
    if (order === null) throw new AppError(404, ErrorCode.notFound, 'Order not found');
    if (order.user_id !== auth.userId) throw new AppError(403, ErrorCode.forbidden, 'This order belongs to another user');

    const tickets = await pool.query<{ ticket_id: string; seat_id: string; qr_token: string; scanned_at: Date | null }>(
      `SELECT ticket_id, seat_id, qr_token, scanned_at FROM tickets WHERE order_id = $1 ORDER BY seat_id`,
      [order.order_id],
    );

    return {
      orderId: order.order_id,
      eventId: order.event_id,
      holdId: order.hold_id,
      seatIds: order.seat_ids,
      amountPaise: Number(order.amount_paise),
      status: order.status,
      failureReason: order.failure_reason,
      tickets: tickets.rows,
    };
  });

  return app;
}
