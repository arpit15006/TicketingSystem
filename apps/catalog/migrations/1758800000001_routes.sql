-- Up Migration
--
-- PRD §8.4 — routes for journey-based inventory. Additive: existing events keep
-- `allocation_mode = 'whole'` and behave exactly as before.

CREATE TABLE routes (
  route_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      TEXT NOT NULL
);

CREATE TABLE route_stops (
  route_id      UUID NOT NULL REFERENCES routes(route_id) ON DELETE CASCADE,
  stop_sequence INT  NOT NULL,      -- 0-based, strictly increasing
  stop_name     TEXT NOT NULL,
  PRIMARY KEY (route_id, stop_sequence)
);

ALTER TABLE events
  ADD COLUMN allocation_mode TEXT NOT NULL DEFAULT 'whole',
  ADD COLUMN route_id UUID REFERENCES routes(route_id);

ALTER TABLE events
  ADD CONSTRAINT events_allocation_mode CHECK (allocation_mode IN ('whole', 'segmented')),
  -- A segmented event without a route has no stops to sell legs between.
  ADD CONSTRAINT events_segmented_needs_route
    CHECK (allocation_mode = 'whole' OR route_id IS NOT NULL);

-- Down Migration
ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_segmented_needs_route,
  DROP CONSTRAINT IF EXISTS events_allocation_mode,
  DROP COLUMN IF EXISTS route_id,
  DROP COLUMN IF EXISTS allocation_mode;
DROP TABLE IF EXISTS route_stops;
DROP TABLE IF EXISTS routes;
