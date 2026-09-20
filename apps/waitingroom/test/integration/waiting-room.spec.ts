import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startStack, type Stack } from '../../../../test/stack.js';
import { register, seedOnSaleEvent, holdSeats, bearer } from '../../../../test/booking-flow.js';

/** PRD §12 — the virtual queue, admission control, and gateway enforcement. */
describe('waiting room', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack();
  }, 300_000);

  afterAll(async () => {
    await stack.stop();
  });

  const joinQueue = async (eventId: string, token: string): Promise<{ status: number; body: any }> =>
    stack.request('POST', `/queue/${eventId}/join`, { headers: bearer(token), baseUrl: stack.direct.waitingroom });

  const queueStatus = async (eventId: string, token: string): Promise<{ status: number; body: any }> =>
    stack.request('GET', `/queue/${eventId}/status`, { headers: bearer(token), baseUrl: stack.direct.waitingroom });

  it('orders the queue by arrival and keeps a position stable across rejoins', async () => {
    const eventId = randomUUID();
    const users = await Promise.all([register(stack), register(stack), register(stack)]);

    // Sequential joins so arrival order is unambiguous.
    for (const user of users) {
      const joined = await joinQueue(eventId, user.accessToken);
      expect(joined.status).toBe(200);
      expect(joined.body.degraded).toBe(false);
    }

    const positions = [];
    for (const user of users) positions.push((await queueStatus(eventId, user.accessToken)).body.position);
    expect(positions).toEqual([1, 2, 3]);

    // Refreshing the page must not send you to the back of the queue — ZADD NX.
    await joinQueue(eventId, users[2]!.accessToken);
    expect((await queueStatus(eventId, users[2]!.accessToken)).body.position).toBe(3);
    expect((await queueStatus(eventId, users[0]!.accessToken)).body.total).toBe(3);
  }, 300_000);

  it('admits from the head of the queue and issues an admission token', async () => {
    const eventId = randomUUID();
    const first = await register(stack);
    const second = await register(stack);

    await joinQueue(eventId, first.accessToken);
    await joinQueue(eventId, second.accessToken);

    const admitted = await stack.admitNow(eventId, 1);
    expect(admitted).toEqual([first.userId]);

    const firstStatus = await queueStatus(eventId, first.accessToken);
    expect(firstStatus.body.admitted).toBe(true);
    expect(firstStatus.body.admissionToken).toBeDefined();

    // The person behind moves up rather than being admitted too.
    const secondStatus = await queueStatus(eventId, second.accessToken);
    expect(secondStatus.body.admitted).toBe(false);
    expect(secondStatus.body.position).toBe(1);
    expect(secondStatus.body.admissionToken).toBeUndefined();
  }, 300_000);

  it('estimates the wait from the admission rate', async () => {
    const eventId = randomUUID();
    const users = await Promise.all(Array.from({ length: 6 }, () => register(stack)));
    for (const user of users) await joinQueue(eventId, user.accessToken);

    const last = await queueStatus(eventId, users[5]!.accessToken);
    expect(last.body.position).toBe(6);
    // 6 ahead at 2/second.
    expect(last.body.estimatedWaitSeconds).toBe(3);
  }, 300_000);

  it('blocks a booking for a waiting-room event without an admission token', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 10, { waitingRoomEnabled: true });
    const buyer = await register(stack);

    const availability = await stack.request('GET', `/availability?eventId=${eventId}&limit=5`);
    const seatId = availability.body.seats[0].seat_id as string;

    const blocked = await stack.request('POST', '/reservations', {
      headers: bearer(buyer.accessToken),
      body: { eventId, seatIds: [seatId] },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('FORBIDDEN');

    // The seat must be untouched by a rejected attempt.
    const seat = await stack.pools.reservation.query<{ status: string }>(
      `SELECT status FROM seats WHERE seat_id = $1`,
      [seatId],
    );
    expect(seat.rows[0]?.status).toBe('available');
  }, 300_000);

  it('lets an admitted user through, end to end', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 10, { waitingRoomEnabled: true });
    const buyer = await register(stack);

    await joinQueue(eventId, buyer.accessToken);
    await stack.admitNow(eventId, 1);

    const status = await queueStatus(eventId, buyer.accessToken);
    const admissionToken = status.body.admissionToken as string;
    expect(admissionToken).toBeDefined();

    const availability = await stack.request('GET', `/availability?eventId=${eventId}&limit=5`);
    const seatId = availability.body.seats[0].seat_id as string;

    const hold = await stack.request('POST', '/reservations', {
      headers: { ...bearer(buyer.accessToken), 'x-admission-token': admissionToken },
      body: { eventId, seatIds: [seatId] },
    });
    expect(hold.status).toBe(201);
  }, 300_000);

  it('refuses an admission token issued for a different event or user', async () => {
    const eventA = await seedOnSaleEvent(stack, 10, { waitingRoomEnabled: true });
    const eventB = await seedOnSaleEvent(stack, 10, { waitingRoomEnabled: true });
    const buyer = await register(stack);
    const stranger = await register(stack);

    await joinQueue(eventA.eventId, buyer.accessToken);
    await stack.admitNow(eventA.eventId, 1);
    const tokenForA = (await queueStatus(eventA.eventId, buyer.accessToken)).body.admissionToken as string;

    const availabilityB = await stack.request('GET', `/availability?eventId=${eventB.eventId}&limit=5`);
    const seatInB = availabilityB.body.seats[0].seat_id as string;

    // Admission to one event must not open another.
    const crossEvent = await stack.request('POST', '/reservations', {
      headers: { ...bearer(buyer.accessToken), 'x-admission-token': tokenForA },
      body: { eventId: eventB.eventId, seatIds: [seatInB] },
    });
    expect(crossEvent.status).toBe(403);

    // Nor may it be handed to somebody else.
    const availabilityA = await stack.request('GET', `/availability?eventId=${eventA.eventId}&limit=5`);
    const seatInA = availabilityA.body.seats[0].seat_id as string;
    const transferred = await stack.request('POST', '/reservations', {
      headers: { ...bearer(stranger.accessToken), 'x-admission-token': tokenForA },
      body: { eventId: eventA.eventId, seatIds: [seatInA] },
    });
    expect(transferred.status).toBe(403);
  }, 300_000);

  it('rejects a forged admission token at the gateway before it reaches a service', async () => {
    const forged = await stack.request('GET', '/catalog/events', {
      headers: { 'x-admission-token': 'not.a.token' },
    });
    expect(forged.status).toBe(403);
  }, 300_000);

  it('does not require admission for an event with no waiting room', async () => {
    const { eventId } = await seedOnSaleEvent(stack, 10, { waitingRoomEnabled: false });
    const buyer = await register(stack);
    const hold = await holdSeats(stack, { eventId, token: buyer.accessToken, count: 1 });
    expect(hold.holdId).toBeDefined();
  }, 300_000);

  it('streams position over SSE and switches to an admitted event', async () => {
    const eventId = randomUUID();
    const first = await register(stack);
    const second = await register(stack);
    await joinQueue(eventId, first.accessToken);
    await joinQueue(eventId, second.accessToken);

    const response = await fetch(`${stack.direct.waitingroom}/queue/${eventId}/position`, {
      headers: bearer(second.accessToken),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawPosition = false;
    let admittedPayload: { admissionToken?: string } | null = null;

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && admittedPayload === null) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      if (!sawPosition && buffer.includes('event: position')) {
        sawPosition = true;
        // ADR-016 — SSE carries an id, which is what makes Last-Event-ID resumption work.
        expect(buffer).toContain('id: ');
        // Now let this user reach the front.
        await stack.admitNow(eventId, 2);
      }

      const match = /event: admitted\ndata: (.+)\n/.exec(buffer);
      if (match !== null) admittedPayload = JSON.parse(match[1]!) as { admissionToken?: string };
    }

    await reader.cancel();

    expect(sawPosition).toBe(true);
    expect(admittedPayload).not.toBeNull();
    // The stream hands over the token, so the client never has to poll for it.
    expect(admittedPayload?.admissionToken).toBeDefined();
  }, 300_000);
});
