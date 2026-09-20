import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventType } from '@ticketing/contracts';
import { ACQUIRE_HOLD_SQL } from '../../../reservation/src/allocation.js';
import { startEventHarness, type EventHarness } from '../helpers.js';

/**
 * ============================================================================
 *  PRD §16 Phase 4 acceptance — KILL THE BROKER
 * ============================================================================
 *
 *  "Killing the broker for 30s loses zero events; they publish on recovery."
 *
 *  The outage is driven by observed state rather than a fixed sleep (PRD §19
 *  forbids sleeping in tests): the broker is genuinely stopped, the relay is run
 *  repeatedly and observed to fail, and only then is the broker revived. That is
 *  strictly stronger than waiting 30 seconds and hoping something happened.
 *
 *  Two properties are under test:
 *    1. ADR-005 — nothing is marked published that was not sent, so an outage
 *       costs latency and never data.
 *    2. INV-7 — seat allocation does not depend on Kafka being available. The
 *       business keeps selling seats while the broker is down.
 */
describe('chaos: the Kafka broker dies mid-sale', () => {
  let harness: EventHarness;

  beforeAll(async () => {
    harness = await startEventHarness();
  }, 300_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('loses zero events across a broker outage and publishes them all on recovery', async () => {
    // ── Baseline: the pipeline works ──────────────────────────────────────
    await harness.writeOutbox({ eventType: EventType.OrderConfirmed, payload: { userId: randomUUID(), seatIds: [randomUUID()] } });
    expect((await harness.relay.runOnce()).failed).toBe(false);
    await harness.waitFor(async () => (await harness.notificationCount()) >= 1, 'baseline notification');

    const publishedBefore = await harness.publishedCount();
    const processedBefore = await harness.processedCount();

    // ── THE BROKER DIES ───────────────────────────────────────────────────
    await harness.broker.kill();

    // ── Business continues. Seats are still sold, using the REAL allocation
    //    SQL from the reservation service — Kafka is simply not on that path.
    const eventId = randomUUID();
    const tierId = randomUUID();
    const seats = await harness.producerPool.query<{ seat_id: string }>(
      `INSERT INTO seats (event_id, section, row_label, seat_number, tier_id)
       SELECT $1, 'A', 'R1', g::text, $2 FROM generate_series(1, 20) AS g
       RETURNING seat_id`,
      [eventId, tierId],
    );
    const seatIds = seats.rows.map((r) => r.seat_id);

    const holdId = randomUUID();
    const held = await harness.producerPool.query<{ seat_id: string }>(ACQUIRE_HOLD_SQL, [holdId, '480', seatIds]);

    // INV-7 — the correctness path never consults the broker.
    expect(held.rowCount).toBe(20);

    // ── 25 events pile up in the outbox while the broker is gone ──────────
    const orphaned: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      orphaned.push(
        await harness.writeOutbox({
          eventType: EventType.OrderConfirmed,
          payload: { userId: randomUUID(), orderId: randomUUID(), seatIds: [randomUUID()] },
        }),
      );
    }

    // ── The relay keeps trying, and keeps failing, and loses nothing ──────
    let failedCycles = 0;
    for (let i = 0; i < 5; i += 1) {
      const cycle = await harness.relay.runOnce();
      if (cycle.failed) failedCycles += 1;
      expect(cycle.published).toBe(0);
    }
    expect(failedCycles).toBe(5);

    // Nothing was marked published that was never sent. This is the assertion
    // the whole outbox pattern exists to make true.
    expect(await harness.unpublishedCount()).toBe(25);
    expect(await harness.publishedCount()).toBe(publishedBefore);
    expect(await harness.processedCount()).toBe(processedBefore);

    // ── THE BROKER COMES BACK ─────────────────────────────────────────────
    await harness.broker.revive();

    // ── Everything publishes, with no intervention ────────────────────────
    await harness.waitFor(
      async () => {
        await harness.relay.runOnce();
        return (await harness.unpublishedCount()) === 0;
      },
      'the outbox to drain after recovery',
      120_000,
    );

    expect(await harness.unpublishedCount()).toBe(0);
    expect(await harness.publishedCount()).toBe(publishedBefore + 25);

    // ── The consumer receives each event exactly once ─────────────────────
    await harness.waitFor(
      async () => (await harness.processedCount()) >= processedBefore + 25,
      'the consumer to catch up after recovery',
      120_000,
    );

    // Idempotency holds across the outage: redeliveries during reconnection
    // must not become duplicate notifications.
    const processed = await harness.processedCount();
    const notifications = await harness.notificationCount();
    expect(processed).toBe(processedBefore + 25);
    expect(notifications).toBe(processed);

    const duplicates = await harness.notificationPool.query<{ count: string }>(
      `SELECT count(*) FROM (SELECT event_id FROM notifications GROUP BY event_id HAVING count(*) > 1) AS d`,
    );
    expect(Number(duplicates.rows[0]?.count)).toBe(0);
  }, 300_000);

  it('an event written during the outage is never silently dropped', async () => {
    const processedBefore = await harness.processedCount();

    await harness.broker.kill();
    const rowId = await harness.writeOutbox({
      eventType: EventType.OrderCompensated,
      payload: { userId: randomUUID(), orderId: randomUUID(), seatIds: [randomUUID()], reason: 'seat_lost' },
    });

    const duringOutage = await harness.relay.runOnce();
    expect(duringOutage.failed).toBe(true);

    const stillUnpublished = await harness.producerPool.query<{ published_at: Date | null }>(
      `SELECT published_at FROM outbox WHERE id = $1`,
      [rowId],
    );
    expect(stillUnpublished.rows[0]?.published_at).toBeNull();

    await harness.broker.revive();

    await harness.waitFor(
      async () => {
        await harness.relay.runOnce();
        const row = await harness.producerPool.query<{ published_at: Date | null }>(
          `SELECT published_at FROM outbox WHERE id = $1`,
          [rowId],
        );
        return row.rows[0]?.published_at !== null;
      },
      'the orphaned event to publish after recovery',
      120_000,
    );

    await harness.waitFor(
      async () => (await harness.processedCount()) > processedBefore,
      'the compensation notification to arrive',
      120_000,
    );

    // The user still learns their payment was released, just later than usual.
    const compensation = await harness.notificationPool.query<{ count: string }>(
      `SELECT count(*) FROM notifications WHERE kind = 'order_compensated'`,
    );
    expect(Number(compensation.rows[0]?.count)).toBeGreaterThan(0);
  }, 300_000);
});
