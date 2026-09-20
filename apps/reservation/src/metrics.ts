import type { Pool } from 'pg';

/**
 * PRD §6 / ADR-015 — a handful of Prometheus-format counters, not a metrics stack.
 * `oversell_total` is the machine-checkable form of INV-1: an operator, a test, or a
 * CI job can read it without understanding the schema.
 */
const counters = {
  seat_hold_won_total: 0,
  seat_hold_lost_total: 0,
  seat_finalize_failed_total: 0,
  /** Incremented only if an invariant audit finds a violation. Must always be 0. */
  oversell_total: 0,
  /**
   * Peak number of allocation handlers in flight at the same instant.
   *
   * This is the honest measure of whether a concurrency test actually created
   * contention. Counting client sockets does not prove it — the kernel may have
   * serialized them. This counts overlap inside the service, where the race is.
   */
  seat_hold_inflight_peak: 0,
};

let inflight = 0;

export function enterAllocation(): void {
  inflight += 1;
  if (inflight > counters.seat_hold_inflight_peak) counters.seat_hold_inflight_peak = inflight;
}

export function exitAllocation(): void {
  inflight -= 1;
}

export type CounterName = keyof typeof counters;

export function incr(name: CounterName, by = 1): void {
  counters[name] += by;
}

export function snapshot(): Readonly<Record<CounterName, number>> {
  return { ...counters };
}

/** Test-only: counters are process-global, so suites must be able to zero them. */
export function resetCounters(): void {
  for (const key of Object.keys(counters) as CounterName[]) counters[key] = 0;
  inflight = 0;
}

export interface InvariantAudit {
  /** INV-1: a seat sold under more than one order. */
  seatsWithMultipleOrders: number;
  /** INV-4 support: sold with no order attached at all. */
  soldWithoutOrder: number;
  /** INV-2 support: held with no hold row pointing at it. */
  heldWithoutHold: number;
}

/**
 * Runs the invariant as an actual query rather than trusting that the code is right.
 *
 * In whole-seat mode the schema makes a double-sale structurally unrepresentable —
 * one seat is one row with one order_id — so this reads 0 by construction, and that
 * is the honest claim to make about it. It is still worth running: it is the same
 * assertion the segmented mode (Phase 8) needs, where overlapping sold occupancies
 * ARE representable and the GiST EXCLUDE constraint is what stops them.
 */
export async function auditInvariants(pool: Pool): Promise<InvariantAudit> {
  const result = await pool.query<{
    seats_with_multiple_orders: string;
    sold_without_order: string;
    held_without_hold: string;
  }>(`
    SELECT
      (SELECT count(*) FROM (
         SELECT seat_id FROM seats WHERE status = 'sold'
         GROUP BY seat_id HAVING count(DISTINCT order_id) > 1
       ) AS d)                                                          AS seats_with_multiple_orders,
      (SELECT count(*) FROM seats WHERE status = 'sold' AND order_id IS NULL)  AS sold_without_order,
      (SELECT count(*) FROM seats WHERE status = 'held' AND hold_id IS NULL)   AS held_without_hold
  `);

  const row = result.rows[0];
  if (row === undefined) throw new Error('invariant audit returned no row');

  const audit: InvariantAudit = {
    seatsWithMultipleOrders: Number(row.seats_with_multiple_orders),
    soldWithoutOrder: Number(row.sold_without_order),
    heldWithoutHold: Number(row.held_without_hold),
  };

  counters.oversell_total = audit.seatsWithMultipleOrders;
  return audit;
}

export function renderPrometheus(audit: InvariantAudit): string {
  const c = snapshot();
  return [
    '# HELP oversell_total Seats sold under more than one order (INV-1). Must always be 0.',
    '# TYPE oversell_total counter',
    `oversell_total ${c.oversell_total}`,
    '# HELP seat_hold_won_total Hold requests that acquired every requested seat.',
    '# TYPE seat_hold_won_total counter',
    `seat_hold_won_total ${c.seat_hold_won_total}`,
    '# HELP seat_hold_lost_total Hold requests rejected because a seat was taken.',
    '# TYPE seat_hold_lost_total counter',
    `seat_hold_lost_total ${c.seat_hold_lost_total}`,
    '# HELP seat_finalize_failed_total Finalizations that found the seat gone (410).',
    '# TYPE seat_finalize_failed_total counter',
    `seat_finalize_failed_total ${c.seat_finalize_failed_total}`,
    '# HELP seat_hold_inflight_peak Peak concurrent allocation handlers observed.',
    '# TYPE seat_hold_inflight_peak gauge',
    `seat_hold_inflight_peak ${c.seat_hold_inflight_peak}`,
    '# HELP seats_sold_without_order Seats in sold state with no order attached.',
    '# TYPE seats_sold_without_order gauge',
    `seats_sold_without_order ${audit.soldWithoutOrder}`,
    '# HELP seats_held_without_hold Seats in held state with no hold attached.',
    '# TYPE seats_held_without_hold gauge',
    `seats_held_without_hold ${audit.heldWithoutHold}`,
    '',
  ].join('\n');
}
