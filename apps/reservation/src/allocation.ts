/**
 * ============================================================================
 *  THE SEAT ALLOCATION ALGORITHM  —  PRD §8, ADR-002, ADR-003
 * ============================================================================
 *
 *  This file is the intellectual core of the project and is deliberately the
 *  least abstracted code in the repository. The SQL below is the PRD's SQL,
 *  verbatim, because a reviewer should be able to check the correctness argument
 *  by reading it rather than by tracing a query builder.
 *
 *  Two ideas carry all the weight:
 *
 *  1. THE LOCK IS THE DATA (ADR-002). There is no Redis lock, no Redlock, no
 *     lease and no fencing token. A conditional UPDATE evaluates the condition
 *     and performs the mutation as ONE operation against committed state, under
 *     a row lock Postgres takes for us. Zero rows returned means we lost the
 *     race. There is no window between checking and acting in which a paused
 *     process can act on a stale belief.
 *
 *  2. EXPIRY IS A PREDICATE (ADR-003). `held_until < now()` lives in the WHERE
 *     clause. A hold is expired the instant the clock passes it, whether or not
 *     any job has "processed" it. Nothing on the correctness path can fail to run,
 *     because nothing on the correctness path runs on a schedule.
 */

import type { PoolClient } from 'pg';
import { EventType } from '@ticketing/contracts';
import { writeOutbox } from './outbox.js';

/* -------------------------------------------------------------------------- */
/*  SQL                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * PRD §8.1 — acquire a hold on a specific set of seats.
 *
 * A seat is claimable when it is available, OR when it is held by a hold whose
 * clock has already run out. The second branch is what makes an abandoned
 * checkout self-healing: the seat returns to the market at its expiry instant,
 * with no reaper involved.
 */
export const ACQUIRE_HOLD_SQL = `
  UPDATE seats
  SET status = 'held',
      hold_id = $1,
      held_until = now() + ($2 || ' seconds')::interval,
      version = version + 1,
      updated_at = now()
  WHERE seat_id = ANY($3)
    AND (
      status = 'available'
      OR (status = 'held' AND held_until < now())
    )
  RETURNING seat_id
`;

/**
 * PRD §8.3 — finalize a sale. Called by orders AFTER payment authorization.
 *
 * Note `held_until > now()`: the hold must still be live at the instant of the
 * sale. A payment that settles one millisecond late finalizes nothing, returns
 * 410, and the orders service compensates (PRD §10.4). That is the race this
 * project refuses to pretend does not exist (ADR-008).
 */
export const FINALIZE_SALE_SQL = `
  UPDATE seats
  SET status = 'sold',
      order_id = $1,
      held_until = NULL,
      version = version + 1,
      updated_at = now()
  WHERE seat_id = ANY($2)
    AND hold_id = $3
    AND status = 'held'
    AND held_until > now()
  RETURNING seat_id
`;

/** Release seats still held by this hold. Sold seats are deliberately untouched. */
export const RELEASE_HOLD_SQL = `
  UPDATE seats
  SET status = 'available',
      hold_id = NULL,
      held_until = NULL,
      version = version + 1,
      updated_at = now()
  WHERE seat_id = ANY($1)
    AND hold_id = $2
    AND status = 'held'
  RETURNING seat_id
`;

/**
 * PRD §8.1 — general admission: any N seats from a tier rather than chosen seats.
 *
 * SKIP LOCKED is essential. Without it, a thousand buyers asking for "any seat"
 * all queue behind the same first row and the system serializes into a single
 * file. With it, each transaction walks past rows another transaction is already
 * working on and takes the next free one.
 */
export const GENERAL_ADMISSION_PICK_SQL = `
  SELECT seat_id FROM seats
  WHERE event_id = $1 AND tier_id = $2
    AND (status = 'available' OR (status = 'held' AND held_until < now()))
  ORDER BY seat_id
  FOR UPDATE SKIP LOCKED
  LIMIT $3
`;

/**
 * The availability predicate, in one place (ADR-003 cost note): anything reading
 * availability MUST apply the same expiry rule, or it will report a seat as taken
 * that the allocator would happily sell.
 */
export const AVAILABLE_SEATS_SQL = `
  SELECT seat_id, section, row_label, seat_number, tier_id
  FROM seats
  WHERE event_id = $1
    AND (status = 'available' OR (status = 'held' AND held_until < now()))
  ORDER BY section, row_label, seat_number
  LIMIT $2
`;

/**
 * Organizer dashboard aggregate: how much of an event has actually sold.
 *
 * The three buckets partition the seat table exactly, and `available` reuses the
 * predicate from `AVAILABLE_SEATS_SQL` verbatim — ADR-003 again. A dashboard that
 * counted `status = 'available'` alone would under-report supply by every expired
 * hold, and would start disagreeing with what a buyer can actually book the moment
 * the janitor is switched off. The janitor is cosmetic; this number must not be.
 */
export const SALES_SUMMARY_SQL = `
  SELECT
    (count(*))::int AS total,
    (count(*) FILTER (WHERE status = 'sold'))::int AS sold,
    (count(*) FILTER (WHERE status = 'held' AND held_until >= now()))::int AS held,
    (count(*) FILTER (WHERE status = 'available' OR (status = 'held' AND held_until < now())))::int AS available
  FROM seats
  WHERE event_id = $1
`;

/**
 * PRD §8.2 — the janitor. Cosmetic only: it tidies rows that the predicate already
 * treats as available, purely so naive SELECTs and analytics read cleanly.
 * IT IS SAFE FOR THIS TO NEVER RUN. No test depends on it.
 */
export const JANITOR_SQL = `
  UPDATE seats
  SET status = 'available', hold_id = NULL, held_until = NULL, updated_at = now()
  WHERE status = 'held' AND held_until < now() - interval '1 minute'
`;

/* -------------------------------------------------------------------------- */
/*  Operations                                                                 */
/* -------------------------------------------------------------------------- */

export interface AcquireHoldParams {
  client: PoolClient;
  eventId: string;
  userId: string;
  seatIds: string[];
  holdSeconds: number;
  requestId: string | null;
}

export interface AcquireHoldResult {
  holdId: string;
  expiresAt: Date;
  seatIds: string[];
}

/**
 * Acquire a hold on an explicit basket of seats, all or nothing (PRD §8.1).
 *
 * The caller runs this inside a transaction and rolls back when the result is a
 * shortfall. Partial baskets are not a thing: a buyer who asked for four seats
 * together does not want two.
 */
export async function acquireHold(
  params: AcquireHoldParams,
): Promise<AcquireHoldResult | { shortfall: true; acquired: string[] }> {
  const { client, eventId, userId, seatIds, holdSeconds, requestId } = params;

  // Insert the hold first so the seat rows can point at a real hold_id. If the
  // allocation below falls short, the whole transaction — this row included —
  // rolls back, so a failed attempt leaves no trace.
  const holdInsert = await client.query<{ hold_id: string; expires_at: Date }>(
    `INSERT INTO holds (event_id, user_id, seat_ids, status, expires_at)
     VALUES ($1, $2, $3, 'active', now() + ($4 || ' seconds')::interval)
     RETURNING hold_id, expires_at`,
    [eventId, userId, seatIds, String(holdSeconds)],
  );

  const hold = holdInsert.rows[0];
  if (hold === undefined) throw new Error('hold insert returned no row');

  const held = await client.query<{ seat_id: string }>(ACQUIRE_HOLD_SQL, [hold.hold_id, String(holdSeconds), seatIds]);

  // THE CHECK. Fewer rows than requested means at least one seat was taken by a
  // transaction that committed before ours. We lost; roll back the entire basket.
  //
  // The rows we DID claim are returned so the caller can name the ones we did not.
  // Re-querying the seats here instead would read our own uncommitted UPDATE and
  // report every seat in the basket as unavailable.
  if (held.rowCount !== seatIds.length) {
    return { shortfall: true, acquired: held.rows.map((r) => r.seat_id) };
  }

  await writeOutbox(client, {
    aggregateId: eventId,
    eventType: EventType.SeatHeld,
    payload: {
      holdId: hold.hold_id,
      eventId,
      userId,
      seatIds: held.rows.map((r) => r.seat_id),
      expiresAt: hold.expires_at.toISOString(),
    },
    requestId,
  });

  return { holdId: hold.hold_id, expiresAt: hold.expires_at, seatIds: held.rows.map((r) => r.seat_id) };
}

export interface FinalizeParams {
  client: PoolClient;
  holdId: string;
  orderId: string;
  requestId: string | null;
}

export interface FinalizeResult {
  finalized: string[];
  expected: number;
}

/**
 * PRD §8.3 — convert a live hold into sold seats, and write SeatSold to the outbox
 * in the same transaction (ADR-005). Returns a shortfall for the caller to turn
 * into 410 Gone; the orders service reads that as "enter compensation".
 */
export async function finalizeHold(params: FinalizeParams): Promise<FinalizeResult> {
  const { client, holdId, orderId, requestId } = params;

  const holdRow = await client.query<{ event_id: string; seat_ids: string[]; status: string }>(
    `SELECT event_id, seat_ids, status FROM holds WHERE hold_id = $1 FOR UPDATE`,
    [holdId],
  );
  const hold = holdRow.rows[0];
  if (hold === undefined) return { finalized: [], expected: 0 };

  // Finalization must be IDEMPOTENT.
  //
  // Kafka delivery is at-least-once and payment webhooks are redelivered by design
  // (ADR-005, ADR-009), so the orders service will call this more than once for the
  // same sale. If an already-converted hold reported failure, a replayed webhook
  // would drive a confirmed order into the compensation path and hand back a seat
  // the customer has already paid for.
  //
  // Note the `order_id = $2` condition: this reports success only when the seats
  // are sold to THIS order. Sold to a different order means the seat really was
  // lost, which is still a 410 and still compensates.
  if (hold.status === 'converted') {
    const already = await client.query<{ seat_id: string }>(
      `SELECT seat_id FROM seats WHERE seat_id = ANY($1) AND status = 'sold' AND order_id = $2`,
      [hold.seat_ids, orderId],
    );
    return { finalized: already.rows.map((r) => r.seat_id), expected: hold.seat_ids.length };
  }

  const sold = await client.query<{ seat_id: string }>(FINALIZE_SALE_SQL, [orderId, hold.seat_ids, holdId]);

  if (sold.rowCount !== hold.seat_ids.length) {
    return { finalized: sold.rows.map((r) => r.seat_id), expected: hold.seat_ids.length };
  }

  await client.query(`UPDATE holds SET status = 'converted' WHERE hold_id = $1`, [holdId]);

  await writeOutbox(client, {
    aggregateId: hold.event_id,
    eventType: EventType.SeatSold,
    payload: { holdId, eventId: hold.event_id, orderId, seatIds: sold.rows.map((r) => r.seat_id) },
    requestId,
  });

  return { finalized: sold.rows.map((r) => r.seat_id), expected: hold.seat_ids.length };
}

/** Release a hold early (user cancelled, countdown hit zero in the browser). */
export async function releaseHold(
  client: PoolClient,
  args: { holdId: string; requestId: string | null },
): Promise<{ released: string[]; eventId: string } | null> {
  const holdRow = await client.query<{ event_id: string; seat_ids: string[]; status: string }>(
    `SELECT event_id, seat_ids, status FROM holds WHERE hold_id = $1 FOR UPDATE`,
    [args.holdId],
  );
  const hold = holdRow.rows[0];
  if (hold === undefined) return null;

  const released = await client.query<{ seat_id: string }>(RELEASE_HOLD_SQL, [hold.seat_ids, args.holdId]);

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

/**
 * PRD §8.1 — general admission. Pick N claimable seats from a tier, locking them
 * with SKIP LOCKED so concurrent buyers walk past each other's rows instead of
 * queueing on the same one. Returns fewer ids than asked when the tier is short.
 */
export async function pickGeneralAdmissionSeats(
  client: PoolClient,
  args: { eventId: string; tierId: string; quantity: number },
): Promise<string[]> {
  const picked = await client.query<{ seat_id: string }>(GENERAL_ADMISSION_PICK_SQL, [
    args.eventId,
    args.tierId,
    args.quantity,
  ]);
  return picked.rows.map((r) => r.seat_id);
}

/** Extend a live hold (PRD §10.1 step 4 — orders extends before taking payment). */
export async function extendHold(
  client: PoolClient,
  args: { holdId: string; seconds: number },
): Promise<{ expiresAt: Date } | null> {
  // Only a hold that is still live may be extended. Extending an already-expired
  // hold would resurrect a claim on seats another buyer may already own.
  const holdRow = await client.query<{ seat_ids: string[]; expires_at: Date }>(
    `UPDATE holds
     SET expires_at = now() + ($2 || ' seconds')::interval
     WHERE hold_id = $1 AND status = 'active' AND expires_at > now()
     RETURNING seat_ids, expires_at`,
    [args.holdId, String(args.seconds)],
  );
  const hold = holdRow.rows[0];
  if (hold === undefined) return null;

  await client.query(
    `UPDATE seats
     SET held_until = now() + ($2 || ' seconds')::interval, updated_at = now()
     WHERE seat_id = ANY($1) AND hold_id = $3 AND status = 'held' AND held_until > now()`,
    [hold.seat_ids, String(args.seconds), args.holdId],
  );

  return { expiresAt: hold.expires_at };
}
