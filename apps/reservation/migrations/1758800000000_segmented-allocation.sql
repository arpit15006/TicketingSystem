-- Up Migration
--
-- PRD §8.4 / ADR-018 — segment-based allocation.
--
-- STRICTLY ADDITIVE. Whole-seat mode does not change: `seats` keeps its status,
-- hold_id and held_until columns and its existing indexes, and every Phase 1-7
-- test must still pass unchanged.
--
-- In segmented mode a seat is not one indivisible unit. A berth on a Delhi →
-- Chennai train can legitimately carry one passenger Delhi → Bhopal and another
-- Bhopal → Chennai. Availability stops being a boolean and becomes "is this seat
-- free across every leg the requested journey spans" — an interval-overlap
-- problem, which Postgres can enforce at the storage layer.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE seat_occupancies (
  occupancy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id      UUID NOT NULL REFERENCES seats(seat_id),
  event_id     UUID NOT NULL,
  -- Half-open [boarding_seq, destination_seq). A passenger travelling stops 0→3
  -- occupies [0,3); another boarding at 3 occupies [3,7). Those do not overlap,
  -- which is exactly right: one alights as the other boards.
  leg_range    int4range NOT NULL,
  state        TEXT NOT NULL,           -- 'held' | 'sold'
  hold_id      UUID,
  order_id     UUID,
  held_until   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT seat_occupancy_state CHECK (state IN ('held', 'sold')),

  /*
   * THE BACKSTOP FOR INV-8.
   *
   * Two sold occupancies of the same seat may never overlap — enforced by the
   * database, not by application code. A bug in the allocation query cannot
   * double-sell a segment; the transaction aborts with 23P01 instead.
   *
   * It covers `state = 'sold'` ONLY, and that limitation is not an oversight.
   * Index predicates in Postgres must be IMMUTABLE and `now()` is not, so a
   * constraint covering *live* holds (`held_until > now()`) cannot be expressed
   * at all. Correctness is therefore two-layered:
   *
   *   sold vs sold              → this constraint, a hard database guarantee
   *   held vs sold, held vs held → the allocation query, serialized by a
   *                                SELECT ... FOR UPDATE row lock on the parent
   *                                `seats` row
   *
   * Any violation of this constraint means the query layer has a hole, and is
   * logged as `segment.exclusion.violated`. It should never fire.
   */
  CONSTRAINT no_sold_segment_overlap
    EXCLUDE USING gist (seat_id WITH =, leg_range WITH &&)
    WHERE (state = 'sold')
);

-- Makes the overlap check an index scan rather than a sequential one.
CREATE INDEX seat_occupancies_lookup ON seat_occupancies USING gist (seat_id, leg_range);

CREATE INDEX seat_occupancies_event ON seat_occupancies (event_id);
CREATE INDEX seat_occupancies_hold ON seat_occupancies (hold_id) WHERE hold_id IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS seat_occupancies;
