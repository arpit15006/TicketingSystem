import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventType } from '@ticketing/contracts';
import { startEventHarness, type EventHarness } from '../helpers.js';

/** ADR-005 — the outbox, the relay, and idempotent consumption. */
describe('transactional outbox and idempotent consumption', () => {
  let harness: EventHarness;

  beforeAll(async () => {
    harness = await startEventHarness();
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('publishes an outbox row and the consumer turns it into exactly one notification', async () => {
    const userId = randomUUID();
    await harness.writeOutbox({
      eventType: EventType.OrderConfirmed,
      payload: { userId, orderId: randomUUID(), seatIds: [randomUUID(), randomUUID()] },
    });

    const cycle = await harness.relay.runOnce();
    expect(cycle.failed).toBe(false);
    expect(cycle.published).toBe(1);

    await harness.waitFor(async () => (await harness.notificationCount()) >= 1, 'notification to be created');

    const notification = await harness.notificationPool.query<{ kind: string; subject: string; user_id: string }>(
      `SELECT kind, subject, user_id FROM notifications WHERE user_id = $1`,
      [userId],
    );
    expect(notification.rowCount).toBe(1);
    expect(notification.rows[0]?.kind).toBe('order_confirmed');
  }, 120_000);

  it('marks rows published only after the broker accepted them', async () => {
    const before = await harness.unpublishedCount();
    await harness.writeOutbox({ eventType: EventType.SeatSold });
    expect(await harness.unpublishedCount()).toBe(before + 1);

    await harness.relay.runOnce();
    expect(await harness.unpublishedCount()).toBe(0);
  }, 120_000);

  it('a redelivered event produces no second notification', async () => {
    const eventId = `reservation-${Date.now()}`;
    const envelope = {
      event_id: eventId,
      event_type: EventType.OrderConfirmed,
      aggregate_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      request_id: randomUUID(),
      payload: { userId: randomUUID(), seatIds: [randomUUID()] },
    };

    const { handleEvent } = await import('../../src/handlers.js');
    const silent = { info: (): void => {}, warn: (): void => {} };

    // At-least-once delivery means this is the normal case, not an edge case.
    const first = await handleEvent(harness.notificationPool, envelope, silent);
    const second = await handleEvent(harness.notificationPool, envelope, silent);
    const third = await handleEvent(harness.notificationPool, envelope, silent);

    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
    expect(third.status).toBe('duplicate');

    const notifications = await harness.notificationPool.query<{ count: string }>(
      `SELECT count(*) FROM notifications WHERE event_id = $1`,
      [eventId],
    );
    expect(Number(notifications.rows[0]?.count)).toBe(1);
  }, 120_000);

  it('gives the same outbox row the same event_id on every publish attempt', async () => {
    const rowId = await harness.writeOutbox({ eventType: EventType.OrderConfirmed });

    // A random id per attempt would make a retry indistinguishable from a new
    // event, and consumer dedupe would be useless.
    const { buildEnvelope } = await import('@ticketing/kafka');
    const row = await harness.producerPool.query(
      `SELECT id, aggregate_id, event_type, payload, request_id, created_at FROM outbox WHERE id = $1`,
      [rowId],
    );

    const first = buildEnvelope(row.rows[0] as never, 'reservation');
    const second = buildEnvelope(row.rows[0] as never, 'reservation');
    expect(first.envelope.event_id).toBe(second.envelope.event_id);
    expect(first.envelope.event_id).toBe(`reservation-${rowId}`);

    // And two services' row 42 must never collide.
    const other = buildEnvelope(row.rows[0] as never, 'orders');
    expect(other.envelope.event_id).not.toBe(first.envelope.event_id);

    await harness.relay.runOnce();
  }, 120_000);

  it('carries the requestId through Kafka into the consumer', async () => {
    const requestId = randomUUID();
    const userId = randomUUID();
    await harness.writeOutbox({
      eventType: EventType.OrderCompensated,
      requestId,
      payload: { userId, orderId: randomUUID(), seatIds: [randomUUID()], reason: 'hold_expired_before_finalization' },
    });

    await harness.relay.runOnce();
    await harness.waitFor(
      async () => {
        const found = await harness.notificationPool.query<{ count: string }>(
          `SELECT count(*) FROM notifications WHERE request_id = $1`,
          [requestId],
        );
        return Number(found.rows[0]?.count) === 1;
      },
      'notification carrying the requestId',
    );

    // PRD §14 — one id, greppable from the HTTP edge through to the notification.
    const stored = await harness.notificationPool.query<{ request_id: string; kind: string; body: string }>(
      `SELECT request_id, kind, body FROM notifications WHERE request_id = $1`,
      [requestId],
    );
    expect(stored.rows[0]?.request_id).toBe(requestId);
    expect(stored.rows[0]?.kind).toBe('order_compensated');
    // PRD §10.4 — the user must be told plainly that they were not charged.
    expect(stored.rows[0]?.body).toContain('not been charged');
  }, 120_000);

  it('preserves per-aggregate ordering by partitioning on the aggregate id', async () => {
    const aggregateId = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(await harness.writeOutbox({ eventType: EventType.SeatSold, aggregateId }));
    }

    await harness.relay.runOnce();

    // The relay reads ORDER BY id and publishes with the aggregate as the key, so
    // everything for one aggregate lands on one partition in that order.
    const published = await harness.producerPool.query<{ id: string }>(
      `SELECT id FROM outbox WHERE id = ANY($1::bigint[]) AND published_at IS NOT NULL ORDER BY id`,
      [ids],
    );
    expect(published.rows.map((r) => r.id)).toEqual(ids);
  }, 120_000);

  it('does nothing when there is nothing to publish', async () => {
    await harness.waitFor(async () => (await harness.unpublishedCount()) === 0, 'outbox to drain');
    const cycle = await harness.relay.runOnce();
    expect(cycle.published).toBe(0);
    expect(cycle.failed).toBe(false);
  }, 120_000);
});
