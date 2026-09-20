import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStack, type Stack } from '../../../../test/stack.js';
import { register, seedOnSaleEvent, holdSeats, placeOrder, bearer } from '../../../../test/booking-flow.js';

/**
 * "My bookings" — PRD §9.2 makes `order:read` own-scoped. The list is filtered by
 * the caller's id, never by a parameter, so there is no request shape that asks
 * for another buyer's orders.
 */
describe('GET /orders lists the caller\'s own bookings', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 240_000);

  afterAll(async () => {
    await stack.stop();
  });

  it('returns own orders newest first, with ticket counts, and nobody else\'s', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 10);
    const alice = await register(stack);
    const bob = await register(stack);

    // Alice: one paid-through order, one left awaiting payment.
    const h1 = await holdSeats(stack, { eventId, token: alice.accessToken, count: 2 });
    const o1 = await placeOrder(stack, { holdId: h1.holdId, token: alice.accessToken });
    const payment = stack.razorpay.authorize(o1.razorpayOrderId);
    await stack.request('POST', `/orders/${o1.orderId}/verify`, {
      headers: bearer(alice.accessToken),
      body: {
        razorpayOrderId: o1.razorpayOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: stack.razorpay.signCheckout(o1.razorpayOrderId, payment.id),
      },
    });
    const h2 = await holdSeats(stack, { eventId, token: alice.accessToken, count: 1 });
    const o2 = await placeOrder(stack, { holdId: h2.holdId, token: alice.accessToken });

    // Bob: one order of his own.
    const h3 = await holdSeats(stack, { eventId, token: bob.accessToken, count: 1 });
    const o3 = await placeOrder(stack, { holdId: h3.holdId, token: bob.accessToken });

    const mine = await stack.request('GET', '/orders', { headers: bearer(alice.accessToken) });
    expect(mine.status).toBe(200);
    const ids = (mine.body.orders as { orderId: string }[]).map((o) => o.orderId);
    expect(ids).toEqual([o2.orderId, o1.orderId]); // newest first
    expect(ids).not.toContain(o3.orderId);

    const confirmed = (mine.body.orders as any[]).find((o) => o.orderId === o1.orderId);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.seatCount).toBe(2);
    expect(confirmed.ticketCount).toBe(2);
    expect(confirmed.scannedCount).toBe(0);
    expect(typeof confirmed.amountPaise).toBe('number');

    const pending = (mine.body.orders as any[]).find((o) => o.orderId === o2.orderId);
    expect(pending.status).toBe('awaiting_payment');
    expect(pending.ticketCount).toBe(0);

    const bobs = await stack.request('GET', '/orders', { headers: bearer(bob.accessToken) });
    expect((bobs.body.orders as { orderId: string }[]).map((o) => o.orderId)).toEqual([o3.orderId]);

    expect((await stack.request('GET', '/orders')).status).toBe(401);
  }, 240_000);
});
