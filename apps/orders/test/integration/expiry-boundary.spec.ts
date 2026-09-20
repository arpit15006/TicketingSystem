import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startStack, type Stack } from '../../../../test/stack.js';
import { register, seedOnSaleEvent, holdSeats, placeOrder, expireHold, bearer } from '../../../../test/booking-flow.js';

/**
 * PRD §15.1 `expiry-boundary.spec.ts` — the case ADR-008 exists for.
 *
 * A payment settles *after* the seat hold expired and the seat was resold. This is
 * the race that cannot be eliminated without a transaction spanning our database
 * and Razorpay's, so the honest answer is: bound the window, detect the failure,
 * compensate automatically, and tell the user plainly.
 *
 * "It can't happen" is the wrong answer. This is the test that proves what happens
 * when it does.
 */
describe('payment after hold expiry: detection and compensation', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 240_000);

  afterAll(async () => {
    await stack.stop();
  });

  it('compensates when the seat is lost between authorization and finalization', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const rival = await register(stack);

    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const seatId = hold.seatIds[0]!;
    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });

    // The customer pays: authorized, not captured (ADR-007).
    const payment = stack.razorpay.authorize(order.razorpayOrderId);
    expect(payment.status).toBe('authorized');

    // ── The hold expires while the payment is in flight ───────────────────
    await expireHold(stack, hold.holdId);

    // ── A rival takes the seat, legitimately: the hold is expired ─────────
    const rivalHold = await stack.request('POST', '/reservations', {
      headers: bearer(rival.accessToken),
      body: { eventId, seatIds: [seatId] },
    });
    expect(rivalHold.status).toBe(201);

    // ── The original customer's callback finally arrives ──────────────────
    const verify = await stack.request('POST', `/orders/${order.orderId}/verify`, {
      headers: bearer(buyer.accessToken),
      body: {
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: stack.razorpay.signCheckout(order.razorpayOrderId, payment.id),
      },
    });

    // The request itself succeeded — it was handled correctly. What failed is the
    // booking, and the user is told exactly that.
    expect(verify.status).toBe(200);
    expect(verify.body.compensated).toBe(true);
    expect(verify.body.status).toBe('refunded_seat_lost');
    expect(verify.body.message).toContain('released');
    expect(verify.body.message).toContain('alternative seats');

    // ── INV-3: money was never captured ───────────────────────────────────
    expect(stack.razorpay.captureCount(payment.id)).toBe(0);
    expect(stack.razorpay.getPayment(payment.id)?.status).toBe('authorized');
    // Nothing to refund, because nothing was ever taken. That is the whole
    // argument for manual capture.
    expect(stack.razorpay.refundCount(payment.id)).toBe(0);

    // ── No ticket was issued ──────────────────────────────────────────────
    const tickets = await stack.pools.orders.query<{ count: string }>(
      `SELECT count(*) FROM tickets WHERE order_id = $1`,
      [order.orderId],
    );
    expect(Number(tickets.rows[0]?.count)).toBe(0);

    const stored = await stack.pools.orders.query<{ status: string; failure_reason: string }>(
      `SELECT status, failure_reason FROM orders WHERE order_id = $1`,
      [order.orderId],
    );
    expect(stored.rows[0]?.status).toBe('refunded_seat_lost');
    expect(stored.rows[0]?.failure_reason).toBe('hold_expired_before_finalization');

    // ── The compensation event was emitted for the notification service ──
    const outbox = await stack.pools.orders.query<{ payload: { reason: string; releaseAction: string } }>(
      `SELECT payload FROM outbox WHERE aggregate_id = $1 AND event_type = 'OrderCompensated'`,
      [order.orderId],
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0]?.payload.releaseAction).toBe('authorization_released');

    // ── INV-1: the seat belongs to the rival, and to nobody else ──────────
    const seat = await stack.pools.reservation.query<{ status: string; hold_id: string; order_id: string | null }>(
      `SELECT status, hold_id, order_id FROM seats WHERE seat_id = $1`,
      [seatId],
    );
    expect(seat.rows[0]?.status).toBe('held');
    expect(seat.rows[0]?.hold_id).toBe(rivalHold.body.holdId);
    expect(seat.rows[0]?.order_id).toBeNull();

    const metrics = await fetch(`${stack.direct.reservation}/metrics`).then((r) => r.text());
    expect(metrics).toContain('oversell_total 0');
  }, 240_000);

  it('refunds rather than releases when the payment was already captured', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });

    const payment = stack.razorpay.authorize(order.razorpayOrderId);
    // Simulate an out-of-band capture (a retry that landed, an operator action).
    await fetch(`${stack.razorpay.baseUrl}/v1/payments/${payment.id}/capture`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${stack.razorpay.keyId}:${stack.razorpay.keySecret}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount: order.amountPaise, currency: 'INR' }),
    });
    expect(stack.razorpay.getPayment(payment.id)?.status).toBe('captured');

    await expireHold(stack, hold.holdId);
    const rival = await register(stack);
    await stack.request('POST', '/reservations', {
      headers: bearer(rival.accessToken),
      body: { eventId, seatIds: hold.seatIds },
    });

    const verify = await stack.request('POST', `/orders/${order.orderId}/verify`, {
      headers: bearer(buyer.accessToken),
      body: {
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: stack.razorpay.signCheckout(order.razorpayOrderId, payment.id),
      },
    });
    expect(verify.body.compensated).toBe(true);

    // Money moved, so it has to move back. INV-3 holds either way.
    expect(stack.razorpay.refundCount(payment.id)).toBe(1);

    const outbox = await stack.pools.orders.query<{ payload: { releaseAction: string } }>(
      `SELECT payload FROM outbox WHERE aggregate_id = $1 AND event_type = 'OrderCompensated'`,
      [order.orderId],
    );
    expect(outbox.rows[0]?.payload.releaseAction).toBe('refunded');
  }, 240_000);

  it('refuses to start a payment when less than 90 seconds of hold remain', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });

    // PRD §10.1.3 — the first of ADR-008's three mechanisms. Shrinking the danger
    // window is cheaper than compensating for it.
    await stack.pools.reservation.query(
      `UPDATE holds SET expires_at = now() + interval '30 seconds' WHERE hold_id = $1`,
      [hold.holdId],
    );

    const order = await stack.request('POST', '/orders', {
      headers: { ...bearer(buyer.accessToken), 'idempotency-key': randomUUID() },
      body: { holdId: hold.holdId },
    });

    expect(order.status).toBe(409);
    expect(order.body.code).toBe('HOLD_NOT_ACTIVE');
    expect(order.body.details.secondsRemaining).toBeLessThan(90);

    // No Razorpay order may have been created for a doomed payment.
    const orders = await stack.pools.orders.query<{ count: string }>(
      `SELECT count(*) FROM orders WHERE hold_id = $1`,
      [hold.holdId],
    );
    expect(Number(orders.rows[0]?.count)).toBe(0);
  }, 240_000);

  it('extends the hold when the payment intent is created', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });

    const before = await stack.pools.reservation.query<{ expires_at: Date }>(
      `SELECT expires_at FROM holds WHERE hold_id = $1`,
      [hold.holdId],
    );

    // Bring it close to the limit but still above 90s, so the order is allowed.
    await stack.pools.reservation.query(
      `UPDATE holds SET expires_at = now() + interval '120 seconds' WHERE hold_id = $1`,
      [hold.holdId],
    );
    await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });

    const after = await stack.pools.reservation.query<{ expires_at: Date }>(
      `SELECT expires_at FROM holds WHERE hold_id = $1`,
      [hold.holdId],
    );

    // PRD §10.1.4 — checkout needs room, so the hold is pushed out.
    expect(after.rows[0]!.expires_at.getTime()).toBeGreaterThan(Date.now() + 500_000);
    expect(before.rows[0]).toBeDefined();
  }, 240_000);

  it('a compensated order cannot later be settled by a late webhook', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });
    const payment = stack.razorpay.authorize(order.razorpayOrderId);

    await expireHold(stack, hold.holdId);
    const rival = await register(stack);
    await stack.request('POST', '/reservations', {
      headers: bearer(rival.accessToken),
      body: { eventId, seatIds: hold.seatIds },
    });

    await stack.request('POST', `/orders/${order.orderId}/verify`, {
      headers: bearer(buyer.accessToken),
      body: {
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: stack.razorpay.signCheckout(order.razorpayOrderId, payment.id),
      },
    });

    // A webhook arriving after compensation must not resurrect the order and
    // charge a customer for a seat that now belongs to somebody else.
    const webhook = stack.razorpay.buildWebhook('payment.authorized', {
      payment: { entity: { id: payment.id, order_id: order.razorpayOrderId, status: 'authorized' } },
    });
    const late = await fetch(`${stack.direct.orders}/orders/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': webhook.signature,
        'x-razorpay-event-id': webhook.eventId,
      },
      body: webhook.body,
    });
    expect(late.status).toBe(200);

    const stored = await stack.pools.orders.query<{ status: string }>(
      `SELECT status FROM orders WHERE order_id = $1`,
      [order.orderId],
    );
    expect(stored.rows[0]?.status).toBe('refunded_seat_lost');
    expect(stack.razorpay.captureCount(payment.id)).toBe(0);
  }, 240_000);
});
