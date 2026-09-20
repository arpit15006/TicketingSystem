-- Up Migration
--
-- PRD §7.4 — catalog_db. Read-heavy, and it NEVER writes seat state: seat
-- inventory belongs to reservation_db and to the one service allowed to decide
-- who gets a seat (PRD §4).

CREATE TABLE venues (
  venue_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  address    TEXT NOT NULL,
  city       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE event_status AS ENUM ('draft', 'published', 'onsale', 'closed');

CREATE TABLE events (
  event_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id             UUID NOT NULL REFERENCES venues(venue_id),
  -- Ownership lives here because catalog is the service that knows it. PRD §9.2's
  -- "events they own" is enforced against this column (ADR-010).
  organizer_id         UUID NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  status               event_status NOT NULL DEFAULT 'draft',
  starts_at            TIMESTAMPTZ NOT NULL,
  onsale_at            TIMESTAMPTZ,
  waiting_room_enabled BOOLEAN NOT NULL DEFAULT false,
  -- PRD §8.1: the 480s hold duration is configurable per event.
  hold_duration_seconds INT NOT NULL DEFAULT 480,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX events_browse ON events (status, starts_at);
CREATE INDEX events_organizer ON events (organizer_id);

CREATE TABLE seat_tiers (
  tier_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- Money in the smallest unit, as an integer. Floats do not belong near money.
  price_paise BIGINT NOT NULL CHECK (price_paise >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, name)
);

CREATE INDEX seat_tiers_event ON seat_tiers (event_id);

CREATE TABLE seatmap_sections (
  section_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  tier_id       UUID NOT NULL REFERENCES seat_tiers(tier_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  row_count     INT NOT NULL CHECK (row_count > 0),
  seats_per_row INT NOT NULL CHECK (seats_per_row > 0),
  -- SVG layout hints for the frontend (PRD §13). Geometry only, never seat state.
  geometry      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, name)
);

CREATE INDEX seatmap_sections_event ON seatmap_sections (event_id);

-- ADR-005 — catalog gets an outbox with the same shape as every other producer.
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  aggregate_id UUID NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  request_id   TEXT,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS seatmap_sections;
DROP TABLE IF EXISTS seat_tiers;
DROP TABLE IF EXISTS events;
DROP TYPE IF EXISTS event_status;
DROP TABLE IF EXISTS venues;
