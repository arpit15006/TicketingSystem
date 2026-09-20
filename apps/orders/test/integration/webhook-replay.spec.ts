import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startStack, type Stack } from '../../../../test/stack.js';
import { register, seedOnSaleEvent, holdSeats, placeOrder, bearer } from '../../../../test/booking-flow.js';

/**
 * PRD §15.1 `webhook-replay.spec.ts` — **the same Razorpay event delivered 50×
 * produces exactly one ticket and exactly one captured payment.**
 *
 * Payment providers deliver webhooks more than once by design. Without dedupe,
 * fifty deliveries means fifty tickets and fifty capture attempts against one
 * customer. This is the test that proves ADR-009 actually works end to end.
 */
describe('webhook replay', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 240_000);

  afterAll(async () => {
    await stack.stop();
  });

  const deliver = async (
    payload: { body: string; signature: string; eventId: string },
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${stack.direct.orders}/orders/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': payload.signature,
        'x-razorpay-event-id': payload.eventId,
      },
      // The exact bytes that were signed — never a re-serialised object.
      body: payload.body,
    });
    return { status: response.status, body: await response.json() };
  };

  it('delivers the same payment.authorized event 50 times and issues exactly one ticket', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });

    // The customer pays. Razorpay authorizes but does NOT capture (ADR-007).
    const payment = stack.razorpay.authorize(order.razorpayOrderId);
    expect(payment.status).toBe('authorized');
    expect(payment.captured).toBe(false);

    const webhook = stack.razorpay.buildWebhook('payment.authorized', {
      payment: { entity: { id: payment.id, order_id: order.razorpayOrderId, status: 'authorized' } },
    });

    // ── 50 identical deliveries of the SAME event id ──────────────────────
    const statuses: number[] = [];
    const duplicates: boolean[] = [];
    for (let i = 0; i < 50; i += 1) {
      const result = await deliver(webhook);
      statuses.push(result.status);
      duplicates.push(result.body.duplicate === true);
    }

    // Every delivery is acknowledged; Razorpay must never be told to retry.
    expect(statuses.every((status) => status === 200)).toBe(true);
    // Exactly one did real work; 49 were recognised as duplicates.
    expect(duplicates.filter((isDuplicate) => !isDuplicate)).toHaveLength(1);
    expect(duplicates.filter((isDuplicate) => isDuplicate)).toHaveLength(49);

    // ── EXACTLY ONE TICKET ────────────────────────────────────────────────
    const tickets = await stack.pools.orders.query<{ count: string }>(
      `SELECT count(*) FROM tickets WHERE order_id = $1`,
      [order.orderId],
    );
    expect(Number(tickets.rows[0]?.count)).toBe(1);

    // ── EXACTLY ONE CAPTURE ───────────────────────────────────────────────
    expect(stack.razorpay.captureCount(payment.id)).toBe(1);
    expect(stack.razorpay.getPayment(payment.id)?.status).toBe('captured');
    expect(stack.razorpay.refundCount(payment.id)).toBe(0);

    // ── One sold seat, one order, one confirmation event ──────────────────
    const order_ = await stack.pools.orders.query<{ status: string }>(
      `SELECT status FROM orders WHERE order_id = $1`,
      [order.orderId],
    );
    expect(order_.rows[0]?.status).toBe('confirmed');

    const sold = await stack.pools.reservation.query<{ count: string }>(
      `SELECT count(*) FROM seats WHERE order_id = $1 AND status = 'sold'`,
      [order.orderId],
    );
    expect(Number(sold.rows[0]?.count)).toBe(1);

    const outbox = await stack.pools.orders.query<{ count: string }>(
      `SELECT count(*) FROM outbox WHERE aggregate_id = $1 AND event_type = 'OrderConfirmed'`,
      [order.orderId],
    );
    expect(Number(outbox.rows[0]?.count)).toBe(1);

    const processed = await stack.pools.orders.query<{ count: string }>(`SELECT count(*) FROM processed_webhooks`);
    expect(Number(processed.rows[0]?.count)).toBe(1);
  }, 240_000);

  it('survives 50 CONCURRENT deliveries of the same event', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });
    const payment = stack.razorpay.authorize(order.razorpayOrderId);

    const webhook = stack.razorpay.buildWebhook('payment.authorized', {
      payment: { entity: { id: payment.id, order_id: order.razorpayOrderId, status: 'authorized' } },
    });

    // Sequential replays are the easy case. Concurrency is where a
    // check-then-insert dedupe would let two deliveries both win.
    const results = await Promise.all(Array.from({ length: 50 }, () => deliver(webhook)));

    expect(results.every((r) => r.status === 200)).toBe(true);

    const tickets = await stack.pools.orders.query<{ count: string }>(
      `SELECT count(*) FROM tickets WHERE order_id = $1`,
      [order.orderId],
    );
    expect(Number(tickets.rows[0]?.count)).toBe(1);
    expect(stack.razorpay.captureCount(payment.id)).toBe(1);
  }, 240_000);

  it('rejects a webhook whose signature does not match the exact bytes', async () => {
    const webhook = stack.razorpay.buildWebhook('payment.authorized', {
      payment: { entity: { id: 'pay_x', order_id: 'order_x', status: 'authorized' } },
    });

    // Re-serialising the SAME object changes key order and whitespace, so the
    // digest no longer matches. This is exactly the bug PRD §10.3 warns about,
    // and it must be caught rather than worked around.
    const reserialized = JSON.stringify(JSON.parse(webhook.body), null, 2);
    const tampered = await fetch(`${stack.direct.orders}/orders/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': webhook.signature,
        'x-razorpay-event-id': webhook.eventId,
      },
      body: reserialized,
    });
    expect(tampered.status).toBe(400);

    // And the event id was never claimed, so a correct redelivery still works.
    const claimed = await stack.pools.orders.query<{ count: string }>(
      `SELECT count(*) FROM processed_webhooks WHERE event_id = $1`,
      [webhook.eventId],
    );
    expect(Number(claimed.rows[0]?.count)).toBe(0);
  });

  it('rejects an unsigned webhook and one signed with the wrong secret', async () => {
    const webhook = stack.razorpay.buildWebhook('payment.authorized', { payment: { entity: { id: 'p', order_id: 'o' } } });

    const unsigned = await fetch(`${stack.direct.orders}/orders/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-event-id': webhook.eventId },
      body: webhook.body,
    });
    expect(unsigned.status).toBe(400);

    const wrongSecret = await fetch(`${stack.direct.orders}/orders/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': 'f'.repeat(64),
        'x-razorpay-event-id': webhook.eventId,
      },
      body: webhook.body,
    });
    expect(wrongSecret.status).toBe(400);
  });

  it('acknowledges event types it does not handle', async () => {
    // PRD §10.3 — anything else must still return 200, or Razorpay retries forever.
    const webhook = stack.razorpay.buildWebhook('subscription.charged', { subscription: { entity: { id: 'sub_1' } } });
    const result = await deliver(webhook);
    expect(result.status).toBe(200);
  });

  it('confirms the order for a customer who closed the browser before the callback', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });
    const payment = stack.razorpay.authorize(order.razorpayOrderId);

    // No /verify call is ever made — the webhook alone drives settlement.
    await deliver(
      stack.razorpay.buildWebhook('payment.authorized', {
        payment: { entity: { id: payment.id, order_id: order.razorpayOrderId, status: 'authorized' } },
      }),
    );

    const view = await stack.request('GET', `/orders/${order.orderId}`, { headers: bearer(buyer.accessToken) });
    expect(view.body.status).toBe('confirmed');
    expect(view.body.tickets).toHaveLength(1);
    expect(view.body.tickets[0].qr_token).toBeDefined();
  }, 240_000);
});
