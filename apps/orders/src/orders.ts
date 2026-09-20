import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { EventType, type OrderStatus } from '@ticketing/contracts';
import { withTransaction } from '@ticketing/http';
import type { RazorpayClient } from './razorpay.js';
import type { ReservationClient } from './clients.js';

export interface OrderRow {
  order_id: string;
  user_id: string;
  event_id: string;
  hold_id: string;
  seat_ids: string[];
  amount_paise: string;
  status: OrderStatus;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  failure_reason: string | null;
}

async function writeOutbox(
  client: PoolClient,
  args: { aggregateId: string; eventType: string; payload: unknown; requestId: string | null },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (aggregate_id, event_type, payload, request_id) VALUES ($1, $2, $3, $4)`,
    [args.aggregateId, args.eventType, JSON.stringify(args.payload), args.requestId],
  );
}

export async function findOrder(db: Pool | PoolClient, orderId: string): Promise<OrderRow | null> {
  const found = await db.query<OrderRow>(`SELECT * FROM orders WHERE order_id = $1`, [orderId]);
  return found.rows[0] ?? null;
}

export async function findOrderByRazorpayOrderId(db: Pool, razorpayOrderId: string): Promise<OrderRow | null> {
  const found = await db.query<OrderRow>(`SELECT * FROM orders WHERE razorpay_order_id = $1`, [razorpayOrderId]);
  return found.rows[0] ?? null;
}

export type SettlementOutcome =
  | { kind: 'confirmed'; ticketIds: string[]; alreadySettled: boolean }
  | { kind: 'compensated'; reason: string }
  | { kind: 'terminal'; status: OrderStatus };

export interface SettleDeps {
  pool: Pool;
  razorpay: RazorpayClient;
  reservation: ReservationClient;
  currency: string;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

/**
 * ============================================================================
 *  SETTLEMENT — PRD §10.1 steps 8-10, and §10.4 when it goes wrong
 * ============================================================================
 *
 *  hold → order → payment authorized → SEAT FINALIZED → capture → confirmed
 *
 *  The order of the last three is the whole point (ADR-007). The seat is taken
 *  BEFORE any money moves, so the failure case is "authorization released" and
 *  never "customer charged for a seat someone else owns".
 *
 *  Every step below is individually idempotent, and none of them holds a lock
 *  across a network call:
 *
 *    - finalize is idempotent in the reservation service (a hold already
 *      converted to THIS order reports success)
 *    - capture is guarded by reading the payment's current state first
 *    - confirmation is a conditional UPDATE, and tickets are ON CONFLICT DO
 *      NOTHING behind a UNIQUE seat_id
 *
 *  That is what lets the same webhook arrive fifty times and produce exactly one
 *  ticket and exactly one capture, without a distributed lock anywhere.
 */
export async function settleOrder(
  deps: SettleDeps,
  args: { order: OrderRow; paymentId: string; requestId: string },
): Promise<SettlementOutcome> {
  const { order, paymentId, requestId } = args;

  if (order.status === 'confirmed') {
    // A replay of an already-settled order. Report the existing tickets; issue none.
    const tickets = await deps.pool.query<{ ticket_id: string }>(
      `SELECT ticket_id FROM tickets WHERE order_id = $1`,
      [order.order_id],
    );
    return { kind: 'confirmed', ticketIds: tickets.rows.map((r) => r.ticket_id), alreadySettled: true };
  }

  if (order.status === 'refunded_seat_lost' || order.status === 'failed' || order.status === 'cancelled') {
    return { kind: 'terminal', status: order.status };
  }

  // Record the authorization. Conditional, so a concurrent settlement cannot
  // reorder the state machine behind us.
  await deps.pool.query(
    `UPDATE orders SET status = 'payment_authorized', razorpay_payment_id = $2, updated_at = now()
     WHERE order_id = $1 AND status IN ('created', 'awaiting_payment')`,
    [order.order_id, paymentId],
  );

  // ── Step 1: take the seats. Nothing is captured until this succeeds. ──────
  const finalize = await deps.reservation.finalize(order.hold_id, order.order_id, requestId);

  if (finalize.kind !== 'sold') {
    return compensate(deps, {
      order,
      paymentId,
      requestId,
      reason: finalize.kind === 'seat_lost' ? 'hold_expired_before_finalization' : 'hold_not_found',
    });
  }

  // ── Step 2: capture. Only now does money actually move. ──────────────────
  const payment = await deps.razorpay.fetchPayment(paymentId);
  if (payment.status === 'authorized') {
    await deps.razorpay.capturePayment({
      paymentId,
      amountPaise: Number(order.amount_paise),
      currency: deps.currency,
    });
  } else if (payment.status !== 'captured') {
    // Neither authorized nor captured: there is nothing to collect, and the seat
    // has just been sold. Give it back rather than leave it sold and unpaid (INV-4).
    return compensate(deps, { order, paymentId, requestId, reason: `payment_not_authorized:${payment.status}` });
  }

  // ── Step 3: confirm, issue tickets, and emit the event atomically ────────
  const ticketIds = await withTransaction(deps.pool, async (client) => {
    const confirmed = await client.query(
      `UPDATE orders SET status = 'confirmed', updated_at = now()
       WHERE order_id = $1 AND status IN ('payment_authorized', 'created', 'awaiting_payment')`,
      [order.order_id],
    );

    const issued: string[] = [];
    for (const seatId of order.seat_ids) {
      // UNIQUE(seat_id) is the backstop; ON CONFLICT makes a replay a no-op
      // rather than an error.
      const ticket = await client.query<{ ticket_id: string }>(
        `INSERT INTO tickets (order_id, seat_id, qr_token) VALUES ($1, $2, $3)
         ON CONFLICT (seat_id) DO NOTHING
         RETURNING ticket_id`,
        [order.order_id, seatId, randomBytes(32).toString('base64url')],
      );
      const row = ticket.rows[0];
      if (row !== undefined) issued.push(row.ticket_id);
    }

    // ADR-005 — the event is written in the same transaction as the confirmation,
    // so "order confirmed" and "someone was told" cannot come apart.
    if ((confirmed.rowCount ?? 0) > 0) {
      await writeOutbox(client, {
        aggregateId: order.order_id,
        eventType: EventType.OrderConfirmed,
        payload: {
          orderId: order.order_id,
          userId: order.user_id,
          eventId: order.event_id,
          seatIds: order.seat_ids,
          amountPaise: Number(order.amount_paise),
          paymentId,
        },
        requestId,
      });
    }

    return issued;
  });

  const all = await deps.pool.query<{ ticket_id: string }>(`SELECT ticket_id FROM tickets WHERE order_id = $1`, [
    order.order_id,
  ]);

  deps.log.info({ orderId: order.order_id, paymentId, issued: ticketIds.length }, 'order confirmed');
  return { kind: 'confirmed', ticketIds: all.rows.map((r) => r.ticket_id), alreadySettled: ticketIds.length === 0 };
}

/**
 * PRD §10.4 — the compensation path.
 *
 * The seat was lost between authorization and finalization. Because capture never
 * happened (ADR-007), releasing the customer is the *absence* of an action rather
 * than a refund: Razorpay has no "void" endpoint, and an authorization that is
 * never captured lapses on its own, so no money ever leaves the customer's
 * account. A payment that was somehow already captured is refunded instead.
 *
 * The user is then told plainly: the payment was released, the seat is gone.
 */
export async function compensate(
  deps: SettleDeps,
  args: { order: OrderRow; paymentId: string | null; requestId: string; reason: string },
): Promise<SettlementOutcome> {
  const { order, paymentId, requestId, reason } = args;

  await deps.pool.query(
    `UPDATE orders SET status = 'compensating', failure_reason = $2, updated_at = now()
     WHERE order_id = $1 AND status NOT IN ('confirmed', 'refunded_seat_lost')`,
    [order.order_id, reason],
  );

  let releaseAction = 'authorization_released';

  if (paymentId !== null) {
    const payment = await deps.razorpay.fetchPayment(paymentId);
    if (payment.status === 'captured') {
      // Money did move, so it has to move back.
      await deps.razorpay.refundPayment({ paymentId, amountPaise: Number(order.amount_paise) });
      releaseAction = 'refunded';
    }
  }

  await withTransaction(deps.pool, async (client) => {
    const updated = await client.query(
      `UPDATE orders SET status = 'refunded_seat_lost', updated_at = now()
       WHERE order_id = $1 AND status = 'compensating'`,
      [order.order_id],
    );

    if ((updated.rowCount ?? 0) > 0) {
      await writeOutbox(client, {
        aggregateId: order.order_id,
        eventType: EventType.OrderCompensated,
        payload: {
          orderId: order.order_id,
          userId: order.user_id,
          eventId: order.event_id,
          seatIds: order.seat_ids,
          amountPaise: Number(order.amount_paise),
          reason,
          releaseAction,
        },
        requestId,
      });
    }
  });

  // PRD §10.4 — the dedicated event name an operator greps for.
  deps.log.warn(
    { event: 'payment.after_expiry.compensated', orderId: order.order_id, paymentId, reason, releaseAction },
    'compensated: payment released because the seat was lost',
  );

  return { kind: 'compensated', reason };
}
