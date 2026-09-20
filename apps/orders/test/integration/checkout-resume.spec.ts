import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStack, type Stack } from '../../../../test/stack.js';
import { register, seedOnSaleEvent, holdSeats, placeOrder, bearer } from '../../../../test/booking-flow.js';

/**
 * Resuming a checkout after a reload.
 *
 * A browser that reloads the checkout page has lost everything the
 * order-creation response told it. If the only way back to Razorpay Checkout is
 * to POST /orders again, the second attempt collides with
 * `orders_one_live_per_hold` and the buyer is stuck on a 409 while their seats
 * stay held until expiry — which is exactly what happened in the UI.
 *
 * Two properties make that impossible:
 *
 *  1. `GET /orders/:id` returns the Razorpay handles, so no second POST is
 *     needed to resume.
 *  2. A repeated POST carrying the SAME Idempotency-Key replays the original
 *     order rather than attempting a second one.
 */
describe('a checkout can be resumed without creating a second order', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 240_000);

  afterAll(async () => {
    await stack.stop();
  });

  it('returns the Razorpay handles needed to reopen Checkout', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const created = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });

    const reread = await stack.request('GET', `/orders/${created.orderId}`, {
      headers: bearer(buyer.accessToken),
    });

    expect(reread.status).toBe(200);
    // Everything Checkout needs, available to a browser that kept only the URL.
    expect(reread.body.razorpayOrderId).toBe(created.razorpayOrderId);
    expect(reread.body.razorpayKeyId).toBe(created.razorpayKeyId);
    expect(reread.body.amountPaise).toBe(created.amountPaise);

    // The publishable key only. A secret here would be a disclosure.
    expect(String(reread.body.razorpayKeyId)).toMatch(/^rzp_/);
    expect(JSON.stringify(reread.body)).not.toContain('keySecret');
    expect(JSON.stringify(reread.body)).not.toContain('webhookSecret');
  }, 240_000);

  it('replays the same order when Pay is pressed twice with one key', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 2 });

    // The key the UI derives from the hold, so a second press is a replay.
    const headers = { ...bearer(buyer.accessToken), 'idempotency-key': `order-${hold.holdId}` };

    const first = await stack.request('POST', '/orders', { headers, body: { holdId: hold.holdId } });
    const second = await stack.request('POST', '/orders', { headers, body: { holdId: hold.holdId } });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);

    // One order, and crucially one Razorpay order — a second would leave a
    // live payment intent against seats that already have one.
    const orders = await stack.pools.orders.query<{ count: string }>(
      `SELECT count(*) FROM orders WHERE hold_id = $1`,
      [hold.holdId],
    );
    expect(Number(orders.rows[0]?.count)).toBe(1);
  }, 240_000);

  /** The failure the UI actually hit: a fresh key on every press. */
  it('still refuses a genuinely second order for the same hold', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });

    const first = await stack.request('POST', '/orders', {
      headers: { ...bearer(buyer.accessToken), 'idempotency-key': crypto.randomUUID() },
      body: { holdId: hold.holdId },
    });
    const second = await stack.request('POST', '/orders', {
      headers: { ...bearer(buyer.accessToken), 'idempotency-key': crypto.randomUUID() },
      body: { holdId: hold.holdId },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('CONFLICT');
    // The guard is real and stays — the client must not spend a new key per press.
    expect(second.body.details?.holdId).toBe(hold.holdId);
  }, 240_000);
});
