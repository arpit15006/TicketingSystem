import { randomUUID } from 'node:crypto';
import type { Stack } from './stack.js';

/** A registered user plus the tokens the flow needs. */
export interface TestUser {
  userId: string;
  accessToken: string;
  refreshToken: string;
  email: string;
  password: string;
}

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

export async function register(stack: Stack): Promise<TestUser> {
  const email = `flow.${randomUUID()}@example.com`;
  const password = 'correct horse battery staple';
  const result = await stack.request('POST', '/identity/auth/register', {
    body: { email, password, fullName: 'Flow User' },
  });
  if (result.status !== 201) throw new Error(`register failed: ${result.status}`);
  return { ...result.body, email, password };
}

export interface SeededEvent {
  eventId: string;
  tierId: string;
  admin: TestUser;
  adminToken: string;
}

/** An on-sale event with priced seats, created the way a real organizer would. */
export async function seedOnSaleEvent(
  stack: Stack,
  seatCount = 20,
  options: { waitingRoomEnabled?: boolean } = {},
): Promise<SeededEvent> {
  const admin = await register(stack);
  await stack.pools.identity.query(
    `INSERT INTO role_assignments (user_id, role) VALUES ($1, 'platform_admin') ON CONFLICT DO NOTHING`,
    [admin.userId],
  );
  const login = await stack.request('POST', '/identity/auth/login', {
    body: { email: admin.email, password: admin.password },
  });
  const adminToken = login.body.accessToken as string;

  const venue = await stack.request('POST', '/catalog/venues', {
    headers: bearer(adminToken),
    body: { name: 'Flow Arena', address: '1 Road', city: 'Mumbai' },
  });

  const event = await stack.request('POST', '/catalog/events', {
    headers: bearer(adminToken),
    body: {
      venueId: venue.body.venue_id,
      title: `Flow Event ${randomUUID().slice(0, 8)}`,
      startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      waitingRoomEnabled: options.waitingRoomEnabled ?? false,
    },
  });
  const eventId = event.body.event_id as string;

  const tier = await stack.request('POST', `/catalog/events/${eventId}/tiers`, {
    headers: bearer(adminToken),
    body: { name: 'Gold', pricePaise: 150_000 },
  });
  const tierId = tier.body.tier_id as string;

  await stack.request('POST', `/catalog/events/${eventId}/publish`, {
    headers: bearer(adminToken),
    body: { onsale: true },
  });

  await stack.request('POST', `/inventory/${eventId}/seats`, {
    headers: bearer(adminToken),
    body: [{ name: 'A', tierId, rowCount: 1, seatsPerRow: seatCount }].length > 0
      ? { sections: [{ name: 'A', tierId, rowCount: 1, seatsPerRow: seatCount }] }
      : {},
  });

  return { eventId, tierId, admin, adminToken };
}

export interface HeldSeats {
  holdId: string;
  seatIds: string[];
  expiresAt: string;
}

export async function holdSeats(stack: Stack, args: { eventId: string; token: string; count?: number }): Promise<HeldSeats> {
  const availability = await stack.request('GET', `/availability?eventId=${args.eventId}&limit=50`);
  const seatIds = (availability.body.seats as { seat_id: string }[])
    .slice(0, args.count ?? 1)
    .map((seat) => seat.seat_id);

  const hold = await stack.request('POST', '/reservations', {
    headers: { ...bearer(args.token), 'idempotency-key': randomUUID() },
    body: { eventId: args.eventId, seatIds },
  });
  if (hold.status !== 201) throw new Error(`hold failed: ${hold.status} ${JSON.stringify(hold.body)}`);
  return hold.body as HeldSeats;
}

export interface PlacedOrder {
  orderId: string;
  razorpayOrderId: string;
  razorpayKeyId: string;
  amountPaise: number;
}

export async function placeOrder(stack: Stack, args: { holdId: string; token: string }): Promise<PlacedOrder> {
  const order = await stack.request('POST', '/orders', {
    headers: { ...bearer(args.token), 'idempotency-key': randomUUID() },
    body: { holdId: args.holdId },
  });
  if (order.status !== 201) throw new Error(`order failed: ${order.status} ${JSON.stringify(order.body)}`);
  return order.body as PlacedOrder;
}

/** Force a hold past expiry by writing the clock backwards — never by sleeping. */
export async function expireHold(stack: Stack, holdId: string): Promise<void> {
  await stack.pools.reservation.query(
    `UPDATE holds SET expires_at = now() - interval '1 second' WHERE hold_id = $1`,
    [holdId],
  );
  await stack.pools.reservation.query(
    `UPDATE seats SET held_until = now() - interval '1 second' WHERE hold_id = $1`,
    [holdId],
  );
}
