import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startStack, type Stack } from '../../../../test/stack.js';
import { register, seedOnSaleEvent, holdSeats, placeOrder, bearer } from '../../../../test/booking-flow.js';

describe('orders', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 240_000);

  afterAll(async () => {
    await stack.stop();
  });

  it('runs the happy path: hold → order → authorize → verify → capture → ticket', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 2 });

    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });
    // Two Gold seats at 150,000 paise each.
    expect(order.amountPaise).toBe(300_000);

    const payment = stack.razorpay.authorize(order.razorpayOrderId);
    // ADR-007 — authorized only. Nothing captured before the seat is ours.
    expect(stack.razorpay.captureCount(payment.id)).toBe(0);

    const verify = await stack.request('POST', `/orders/${order.orderId}/verify`, {
      headers: bearer(buyer.accessToken),
      body: {
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: stack.razorpay.signCheckout(order.razorpayOrderId, payment.id),
      },
    });

    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('confirmed');
    expect(verify.body.ticketIds).toHaveLength(2);

    // Capture happens AFTER finalization, exactly once.
    expect(stack.razorpay.captureCount(payment.id)).toBe(1);

    const sold = await stack.pools.reservation.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE order_id = $1 AND status = 'sold'`,
      [order.orderId],
    );
    expect(Number(sold.rows[0]?.count)).toBe(2);

    // INV-1's real backstop: one ticket per seat, enforced by UNIQUE(seat_id).
    const tickets = await stack.pools.orders.query<{ seat_id: string }>(
      `SELECT seat_id FROM tickets WHERE order_id = $1`,
      [order.orderId],
    );
    expect(new Set(tickets.rows.map((r) => r.seat_id)).size).toBe(2);
  }, 240_000);

  it('replays an identical order request instead of creating a second one', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });

    const key = randomUUID();
    const headers = { ...bearer(buyer.accessToken), 'idempotency-key': key };

    const first = await stack.request('POST', '/orders', { headers, body: { holdId: hold.holdId } });
    const replay = await stack.request('POST', '/orders', { headers, body: { holdId: hold.holdId } });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);

    // One order row, and crucially one Razorpay order: a duplicate would leave a
    // second payment intent live against the same seats.
    const orders = await stack.pools.orders.query<{ count: string }>(
      `SELECT count(*) FROM orders WHERE hold_id = $1`,
      [hold.holdId],
    );
    expect(Number(orders.rows[0]?.count)).toBe(1);
  }, 240_000);

  it('rejects the same idempotency key used for a different hold', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const holdA = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const holdB = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });

    const key = randomUUID();
    const headers = { ...bearer(buyer.accessToken), 'idempotency-key': key };

    expect((await stack.request('POST', '/orders', { headers, body: { holdId: holdA.holdId } })).status).toBe(201);

    const reused = await stack.request('POST', '/orders', { headers, body: { holdId: holdB.holdId } });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  }, 240_000);

  it('refuses a second live order for the same hold even without an idempotency key', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });

    const first = await stack.request('POST', '/orders', {
      headers: bearer(buyer.accessToken),
      body: { holdId: hold.holdId },
    });
    expect(first.status).toBe(201);

    // A double-tapped checkout with no key. The partial unique index is what
    // stops two payment intents existing against one hold.
    const second = await stack.request('POST', '/orders', {
      headers: bearer(buyer.accessToken),
      body: { holdId: hold.holdId },
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CONFLICT');
  }, 240_000);

  it('refuses to let one user buy another user\'s hold', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const owner = await register(stack);
    const attacker = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: owner.accessToken, count: 1 });

    const stolen = await stack.request('POST', '/orders', {
      headers: bearer(attacker.accessToken),
      body: { holdId: hold.holdId },
    });
    expect(stolen.status).toBe(403);
  }, 240_000);

  it('rejects a forged checkout signature', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });
    const payment = stack.razorpay.authorize(order.razorpayOrderId);

    // Anyone can guess an order id. Only the HMAC proves the payment is real —
    // the client's "success" callback is an assertion by an untrusted party.
    const forged = await stack.request('POST', `/orders/${order.orderId}/verify`, {
      headers: bearer(buyer.accessToken),
      body: {
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: 'a'.repeat(64),
      },
    });
    expect(forged.status).toBe(400);

    // Nothing captured, no seat sold, no ticket.
    expect(stack.razorpay.captureCount(payment.id)).toBe(0);
    const tickets = await stack.pools.orders.query<{ count: string }>(
      `SELECT count(*) FROM tickets WHERE order_id = $1`,
      [order.orderId],
    );
    expect(Number(tickets.rows[0]?.count)).toBe(0);
  }, 240_000);

  it('rejects a signature computed over a different order', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const holdA = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const holdB = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const orderA = await placeOrder(stack, { holdId: holdA.holdId, token: buyer.accessToken });
    const orderB = await placeOrder(stack, { holdId: holdB.holdId, token: buyer.accessToken });

    const paymentB = stack.razorpay.authorize(orderB.razorpayOrderId);

    // A valid signature, but for the wrong order — replaying someone else's
    // genuine payment against a cheaper order.
    const mismatched = await stack.request('POST', `/orders/${orderA.orderId}/verify`, {
      headers: bearer(buyer.accessToken),
      body: {
        razorpayOrderId: orderB.razorpayOrderId,
        razorpayPaymentId: paymentB.id,
        razorpaySignature: stack.razorpay.signCheckout(orderB.razorpayOrderId, paymentB.id),
      },
    });
    expect(mismatched.status).toBe(400);
  }, 240_000);

  it('verifying twice does not issue a second ticket or capture twice', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });
    const payment = stack.razorpay.authorize(order.razorpayOrderId);

    const body = {
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: payment.id,
      razorpaySignature: stack.razorpay.signCheckout(order.razorpayOrderId, payment.id),
    };

    const first = await stack.request('POST', `/orders/${order.orderId}/verify`, { headers: bearer(buyer.accessToken), body });
    const second = await stack.request('POST', `/orders/${order.orderId}/verify`, { headers: bearer(buyer.accessToken), body });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.ticketIds).toEqual(first.body.ticketIds);
    expect(stack.razorpay.captureCount(payment.id)).toBe(1);
  }, 240_000);

  it('does not expose another user\'s order', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const nosy = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });

    const peek = await stack.request('GET', `/orders/${order.orderId}`, { headers: bearer(nosy.accessToken) });
    expect(peek.status).toBe(403);
  }, 240_000);

  it('never leaks the Razorpay key secret to the client', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });

    const order = await stack.request('POST', '/orders', {
      headers: { ...bearer(buyer.accessToken), 'idempotency-key': randomUUID() },
      body: { holdId: hold.holdId },
    });

    // The publishable key id is needed by Checkout; the secret must never travel.
    expect(order.body.razorpayKeyId).toBe(stack.razorpay.keyId);
    expect(JSON.stringify(order.body)).not.toContain(stack.razorpay.keySecret);
  }, 240_000);
});
