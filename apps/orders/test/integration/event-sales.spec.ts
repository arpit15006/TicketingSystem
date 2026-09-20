import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStack, type Stack } from '../../../../test/stack.js';
import { register, seedOnSaleEvent, holdSeats, placeOrder, bearer } from '../../../../test/booking-flow.js';

describe('organizer sales for an event', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 240_000);

  afterAll(async () => {
    await stack.stop();
  });

  it('reports revenue, counts and per-day buckets to the organizer, and refuses everyone else', async () => {
    const { eventId, adminToken } = await seedOnSaleEvent(stack, 10);
    const buyer = await register(stack);

    // One confirmed (2 seats), one pending.
    const h1 = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 2 });
    const o1 = await placeOrder(stack, { holdId: h1.holdId, token: buyer.accessToken });
    const payment = stack.razorpay.authorize(o1.razorpayOrderId);
    await stack.request('POST', `/orders/${o1.orderId}/verify`, {
      headers: bearer(buyer.accessToken),
      body: { razorpayOrderId: o1.razorpayOrderId, razorpayPaymentId: payment.id, razorpaySignature: stack.razorpay.signCheckout(o1.razorpayOrderId, payment.id) },
    });
    const h2 = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    await placeOrder(stack, { holdId: h2.holdId, token: buyer.accessToken });

    // The seeding admin is platform_admin, which satisfies the grant check.
    const sales = await stack.request('GET', `/orders/events/${eventId}/sales`, { headers: bearer(adminToken) });
    expect(sales.status).toBe(200);
    expect(sales.body.revenuePaise).toBe(o1.amountPaise);
    expect(sales.body.confirmedOrders).toBe(1);
    expect(sales.body.pendingOrders).toBe(1);
    expect(sales.body.ticketsIssued).toBe(2);
    expect(sales.body.ticketsScanned).toBe(0);
    expect(sales.body.byDay).toHaveLength(1);
    expect(sales.body.byDay[0].revenuePaise).toBe(o1.amountPaise);

    const list = await stack.request('GET', `/orders/events/${eventId}/orders`, { headers: bearer(adminToken) });
    expect(list.status).toBe(200);
    expect(list.body.orders).toHaveLength(2);
    expect(list.body.orders.map((o: { status: string }) => o.status).sort()).toEqual(['awaiting_payment', 'confirmed']);

    // A buyer is not the organizer.
    expect((await stack.request('GET', `/orders/events/${eventId}/sales`, { headers: bearer(buyer.accessToken) })).status).toBe(403);
    expect((await stack.request('GET', `/orders/events/${eventId}/orders`)).status).toBe(401);
  }, 240_000);
});
