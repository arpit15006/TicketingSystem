/**
 * ============================================================================
 *  SEGMENTED ALLOCATION — PRD §8.4, ADR-018
 * ============================================================================
 *
 *  The same two ideas as whole-seat allocation, applied to intervals:
 *
 *  1. THE LOCK IS THE DATA. A `SELECT ... FOR UPDATE` on the parent `seats` row
 *     is the per-seat mutex. It serializes every concurrent allocation attempt
 *     for that seat, and it is the same trick as ADR-002 — the lock and the data
 *     are the same object.
 *
 *  2. EXPIRY IS A PREDICATE. `held_until > now()` appears inside the NOT EXISTS
 *     clause, so an expired hold on an overlapping leg blocks nothing and no
 *     reaper is required. ADR-003 carries over intact.
 *
 *  Plus one thing whole-seat mode does not have: a storage-layer backstop. The
 *  GiST EXCLUDE constraint makes two overlapping SOLD occupancies impossible
 *  even if this query were wrong.
 */

import type { PoolClient } from 'pg';
import { EventType } from '@ticketing/contracts';
import { writeOutbox } from './outbox.js';

/**
 * PRD §8.4 — serialize concurrent allocation attempts for one seat.
 * Taken before the overlap check, so the check and the insert cannot interleave.
 */
export const LOCK_SEAT_SQL = `SELECT seat_id FROM seats WHERE seat_id = $1 FOR UPDATE`;

/**
 * PRD §8.4 — insert an occupancy only if no LIVE occupancy overlaps the legs.
 *
 * Zero rows returned means the segment was taken → 409, the same contract as
 * whole-seat mode.
 */
export const ACQUIRE_SEGMENT_SQL = `
  INSERT INTO seat_occupancies (seat_id, event_id, leg_range, state, hold_id, held_until)
  SELECT $1, $2, int4range($3, $4, '[)'), 'held', $5,
         now() + ($6 || ' seconds')::interval
  WHERE NOT EXISTS (
    SELECT 1 FROM seat_occupancies o
    WHERE o.seat_id = $1
      AND o.leg_range && int4range($3, $4, '[)')
      AND (o.state = 'sold'
           OR (o.state = 'held' AND o.held_until > now()))
  )
  RETURNING occupancy_id
`;

/** PRD §8.4 — finalize. Fewer rows than expected → the segment was lost → 410. */
export const FINALIZE_SEGMENT_SQL = `
  UPDATE seat_occupancies
  SET state = 'sold', order_id = $1, held_until = NULL
  WHERE occupancy_id = ANY($2)
    AND hold_id = $3
    AND state = 'held'
    AND held_until > now()
  RETURNING occupancy_id
`;

/**
 * PRD §8.4 — which seats are free across the requested span.
 * The GiST index turns the overlap check into an index scan.
 */
export const SEGMENT_AVAILABILITY_SQL = `
  SELECT s.seat_id, s.section, s.row_label, s.seat_number, s.tier_id
  FROM seats s
  WHERE s.event_id = $1
    AND NOT EXISTS (
      SELECT 1 FROM seat_occupancies o
      WHERE o.seat_id = s.seat_id
        AND o.leg_range && int4range($2, $3, '[)')
        AND (o.state = 'sold'
             OR (o.state = 'held' AND o.held_until > now()))
    )
  ORDER BY s.section, s.row_label, s.seat_number
  LIMIT $4
`;

export const RELEASE_SEGMENT_SQL = `
  DELETE FROM seat_occupancies
  WHERE hold_id = $1 AND state = 'held'
  RETURNING occupancy_id, seat_id
`;

export interface SegmentSpan {
  fromStop: number;
  toStop: number;
}

export interface AcquireSegmentParams {
  client: PoolClient;
  eventId: string;
  userId: string;
  seatIds: string[];
  span: SegmentSpan;
  holdSeconds: number;
  requestId: string | null;
}

export interface AcquireSegmentResult {
  holdId: string;
  expiresAt: Date;
  seatIds: string[];
  occupancyIds: string[];
}

/**
 * Acquire a segmented hold on a basket of seats, all or nothing.
 *
 * The seats are locked in a deterministic order. Two baskets requesting the same
 * seats in different orders would otherwise be able to deadlock on the row locks,
 * and unlike the whole-seat path — which takes its locks in a single statement —
 * this path holds several locks across several statements.
 */
export async function acquireSegments(
  params: AcquireSegmentParams,
): Promise<AcquireSegmentResult | { shortfall: true; acquired: string[] }> {
  const { client, eventId, userId, seatIds, span, holdSeconds, requestId } = params;

  const holdInsert = await client.query<{ hold_id: string; expires_at: Date }>(
    `INSERT INTO holds (event_id, user_id, seat_ids, status, expires_at)
     VALUES ($1, $2, $3, 'active', now() + ($4 || ' seconds')::interval)
     RETURNING hold_id, expires_at`,
    [eventId, userId, seatIds, String(holdSeconds)],
  );
  const hold = holdInsert.rows[0];
  if (hold === undefined) throw new Error('hold insert returned no row');

  const occupancyIds: string[] = [];
  const acquired: string[] = [];

  for (const seatId of [...seatIds].sort()) {
    // 1. The per-seat mutex.
    await client.query(LOCK_SEAT_SQL, [seatId]);

    // 2. Insert only if nothing live overlaps these legs.
    const inserted = await client.query<{ occupancy_id: string }>(ACQUIRE_SEGMENT_SQL, [
      seatId,
      eventId,
      span.fromStop,
      span.toStop,
      hold.hold_id,
      String(holdSeconds),
    ]);

    const row = inserted.rows[0];
    if (row === undefined) {
      // Segment taken. The caller rolls back, which also removes the occupancies
      // acquired above — no partial basket, exactly as in whole-seat mode.
      return { shortfall: true, acquired };
    }
    occupancyIds.push(row.occupancy_id);
    acquired.push(seatId);
  }

  await writeOutbox(client, {
    aggregateId: eventId,
    eventType: EventType.SeatHeld,
    payload: {
      holdId: hold.hold_id,
      eventId,
      userId,
      seatIds,
      expiresAt: hold.expires_at.toISOString(),
      fromStop: span.fromStop,
      toStop: span.toStop,
    },
    requestId,
  });

  return { holdId: hold.hold_id, expiresAt: hold.expires_at, seatIds, occupancyIds };
}

export interface FinalizeSegmentResult {
  finalized: string[];
  expected: number;
}

export async function finalizeSegments(params: {
  client: PoolClient;
  holdId: string;
  orderId: string;
  requestId: string | null;
}): Promise<FinalizeSegmentResult> {
  const { client, holdId, orderId, requestId } = params;

  const holdRow = await client.query<{ event_id: string; seat_ids: string[]; status: string }>(
    `SELECT event_id, seat_ids, status FROM holds WHERE hold_id = $1 FOR UPDATE`,
    [holdId],
  );
  const hold = holdRow.rows[0];
  if (hold === undefined) return { finalized: [], expected: 0 };

  const occupancies = await client.query<{ occupancy_id: string }>(
    `SELECT occupancy_id FROM seat_occupancies WHERE hold_id = $1 ORDER BY occupancy_id`,
    [holdId],
  );

  // Idempotent for the same reason the whole-seat path is: at-least-once webhook
  // delivery means finalize WILL be called more than once for one sale.
  if (hold.status === 'converted') {
    const already = await client.query<{ occupancy_id: string }>(
      `SELECT occupancy_id FROM seat_occupancies WHERE hold_id = $1 AND state = 'sold' AND order_id = $2`,
      [holdId, orderId],
    );
    return { finalized: already.rows.map((r) => r.occupancy_id), expected: occupancies.rowCount ?? 0 };
  }

  const expected = occupancies.rowCount ?? 0;
  const sold = await client.query<{ occupancy_id: string }>(FINALIZE_SEGMENT_SQL, [
    orderId,
    occupancies.rows.map((r) => r.occupancy_id),
    holdId,
  ]);

  if (sold.rowCount !== expected) {
    return { finalized: sold.rows.map((r) => r.occupancy_id), expected };
  }

  await client.query(`UPDATE holds SET status = 'converted' WHERE hold_id = $1`, [holdId]);

  await writeOutbox(client, {
    aggregateId: hold.event_id,
    eventType: EventType.SeatSold,
    payload: { holdId, eventId: hold.event_id, orderId, seatIds: hold.seat_ids },
    requestId,
  });

  return { finalized: sold.rows.map((r) => r.occupancy_id), expected };
}

export async function releaseSegments(
  client: PoolClient,
  args: { holdId: string; requestId: string | null },
): Promise<{ released: string[]; eventId: string } | null> {
  const holdRow = await client.query<{ event_id: string; seat_ids: string[] }>(
    `SELECT event_id, seat_ids FROM holds WHERE hold_id = $1 FOR UPDATE`,
    [args.holdId],
  );
  const hold = holdRow.rows[0];
  if (hold === undefined) return null;

  const released = await client.query<{ occupancy_id: string; seat_id: string }>(RELEASE_SEGMENT_SQL, [args.holdId]);
  await client.query(`UPDATE holds SET status = 'released' WHERE hold_id = $1 AND status = 'active'`, [args.holdId]);

  await writeOutbox(client, {
    aggregateId: hold.event_id,
    eventType: EventType.SeatReleased,
    payload: {
      holdId: args.holdId,
      eventId: hold.event_id,
      seatIds: released.rows.map((r) => r.seat_id),
      reason: 'released',
    },
    requestId: args.requestId,
  });

  return { released: released.rows.map((r) => r.seat_id), eventId: hold.event_id };
}
