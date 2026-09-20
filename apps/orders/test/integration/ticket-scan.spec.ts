import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startStack, makePlatformAdmin, type Stack } from '../../../../test/stack.js';
import { register, seedOnSaleEvent, holdSeats, placeOrder, bearer, type TestUser } from '../../../../test/booking-flow.js';

/**
 * PRD §13 `/scan` — the gate.
 *
 * The scanner is the last place a ticket is checked, and it has the same two
 * hazards as the seat allocator it ultimately protects: the same code is presented
 * repeatedly (screenshots get forwarded), and two turnstiles can read it at the
 * same instant. So it is tested the same way — with a real race, not a sequence.
 */
describe('ticket scanning', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 240_000);

  afterAll(async () => {
    await stack.stop();
  });

  /** Register a user and grant them `scanner` on exactly one event. */
  const scannerFor = async (eventId: string): Promise<string> => {
    const user = await register(stack);
    const admin = await register(stack);
    await makePlatformAdmin(stack.pools.identity, admin.userId);
    const adminLogin = await stack.request('POST', '/identity/auth/login', {
      body: { email: admin.email, password: admin.password },
    });

    const granted = await stack.request('POST', `/identity/users/${user.userId}/roles`, {
      headers: bearer(adminLogin.body.accessToken),
      body: { role: 'scanner', resourceType: 'event', resourceId: eventId },
    });
    expect(granted.status).toBeLessThan(300);

    // Re-login so the new grant is actually in the token's `roles[]` claim.
    const login = await stack.request('POST', '/identity/auth/login', {
      body: { email: user.email, password: user.password },
    });
    return login.body.accessToken as string;
  };

  /** Drive a real purchase all the way to confirmed, and return the QR codes. */
  const buyTickets = async (args: { eventId: string; count: number }): Promise<{ buyer: TestUser; qrTokens: string[]; orderId: string }> => {
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId: args.eventId, token: buyer.accessToken, count: args.count });
    const order = await placeOrder(stack, { holdId: hold.holdId, token: buyer.accessToken });

    const payment = stack.razorpay.authorize(order.razorpayOrderId);
    const verify = await stack.request('POST', `/orders/${order.orderId}/verify`, {
      headers: bearer(buyer.accessToken),
      body: {
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: payment.id,
        razorpaySignature: stack.razorpay.signCheckout(order.razorpayOrderId, payment.id),
      },
    });
    expect(verify.body.status).toBe('confirmed');

    const tickets = await stack.pools.orders.query<{ qr_token: string }>(
      `SELECT qr_token FROM tickets WHERE order_id = $1 ORDER BY seat_id`,
      [order.orderId],
    );
    return { buyer, orderId: order.orderId, qrTokens: tickets.rows.map((r) => r.qr_token) };
  };

  const scan = async (qrToken: string, token: string) =>
    stack.request('POST', '/tickets/scan', { headers: bearer(token), body: { qrToken } });

  it('admits a valid ticket exactly once, and reports a replay rather than failing', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const scannerToken = await scannerFor(eventId);
    const { qrTokens } = await buyTickets({ eventId, count: 1 });

    const first = await scan(qrTokens[0]!, scannerToken);
    expect(first.status).toBe(200);
    expect(first.body.admitted).toBe(true);
    expect(first.body.alreadyScanned).toBe(false);
    expect(first.body.scannedAt).not.toBeNull();

    // A gate scanner re-reads codes constantly. The second read is a normal
    // event with a clear answer, not a 500 and not a silent second admission.
    const replay = await scan(qrTokens[0]!, scannerToken);
    expect(replay.status).toBe(200);
    expect(replay.body.admitted).toBe(false);
    expect(replay.body.alreadyScanned).toBe(true);
    // The original timestamp survives: the ticket was used then, not now.
    expect(replay.body.scannedAt).toBe(first.body.scannedAt);
  }, 240_000);

  /**
   * The race. One forwarded screenshot, two turnstiles, the same millisecond.
   * `scanned_at IS NULL` in the UPDATE is what makes exactly one gate open —
   * the same "the lock IS the data" move as ADR-002, one table over.
   */
  it('opens exactly one gate when the same code is scanned concurrently', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const scannerToken = await scannerFor(eventId);
    const { qrTokens } = await buyTickets({ eventId, count: 1 });

    const results = await Promise.all(
      Array.from({ length: 20 }, async () => scan(qrTokens[0]!, scannerToken)),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.admitted === true)).toHaveLength(1);
    expect(results.filter((r) => r.body.alreadyScanned === true)).toHaveLength(19);

    // And the database agrees: one scan timestamp, written once.
    const scanned = await stack.pools.orders.query<{ scanned_at: Date | null }>(
      `SELECT scanned_at FROM tickets WHERE qr_token = $1`,
      [qrTokens[0]],
    );
    expect(scanned.rows[0]?.scanned_at).not.toBeNull();
  }, 240_000);

  it('refuses a scanner hired for a different event', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const { qrTokens } = await buyTickets({ eventId, count: 1 });

    // A genuine scanner, correctly scoped — to somebody else's show.
    const other = await seedOnSaleEvent(stack, 2);
    const wrongScanner = await scannerFor(other.eventId);

    const attempt = await scan(qrTokens[0]!, wrongScanner);

    expect(attempt.status).toBe(403);
    // The ticket must be untouched, so the real gate still admits it.
    const untouched = await stack.pools.orders.query<{ scanned_at: Date | null }>(
      `SELECT scanned_at FROM tickets WHERE qr_token = $1`,
      [qrTokens[0]],
    );
    expect(untouched.rows[0]?.scanned_at).toBeNull();
  }, 240_000);

  it('refuses an attendee holding no scanner grant at all', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const { buyer, qrTokens } = await buyTickets({ eventId, count: 1 });

    // Even the person who owns the ticket cannot wave themselves in.
    const attempt = await scan(qrTokens[0]!, buyer.accessToken);
    expect(attempt.status).toBe(403);
  }, 240_000);

  it('answers 403 for an unknown code without revealing whether it exists', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 5);
    const scannerToken = await scannerFor(eventId);

    // The event cannot be resolved from a code that matches no ticket, so the
    // scoped permission check refuses before the handler ever runs.
    const attempt = await scan(`nonexistent-${randomUUID()}`, scannerToken);
    expect(attempt.status).toBe(403);
  }, 240_000);
});
