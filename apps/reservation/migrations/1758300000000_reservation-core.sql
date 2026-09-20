-- Up Migration
--
-- PRD §7.1 — reservation_db, the critical schema.
-- Written as raw SQL on purpose (ADR-014): the shape of this schema *is* the
-- correctness argument, and a reviewer should be able to read it without decoding
-- a migration DSL first.

CREATE TYPE seat_status AS ENUM ('available', 'held', 'sold', 'blocked');

CREATE TABLE seats (
  seat_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL,
  section      TEXT NOT NULL,
  row_label    TEXT NOT NULL,
  seat_number  TEXT NOT NULL,
  tier_id      UUID NOT NULL,
  status       seat_status NOT NULL DEFAULT 'available',
  hold_id      UUID,
  order_id     UUID,
  held_until   TIMESTAMPTZ,
  version      INT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, section, row_label, seat_number)
);

-- PRD §7.1 — partial unique index backing INV-1 at the database level.
--
-- Honest note for the reviewer: because seat_id is already the primary key, this
-- index cannot admit a row the PK would not. The *structural* guarantee of INV-1 in
-- this schema is that a seat is one row carrying at most one order_id, so "sold to
-- two orders" has nowhere to be written. The index is kept because the PRD specifies
-- it and because it makes the intent explicit at the storage layer; the constraint
-- that does real work against double-issue is tickets.seat_id UNIQUE in orders_db
-- (PRD §7.2), and in segmented mode the GiST EXCLUDE constraint (PRD §8.4).
CREATE UNIQUE INDEX seats_one_order_per_sold_seat
  ON seats (seat_id) WHERE status = 'sold';

-- Supports the availability predicate: (event_id, status, held_until).
CREATE INDEX seats_availability ON seats (event_id, status, held_until);

CREATE TABLE holds (
  hold_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID NOT NULL,
  user_id      UUID NOT NULL,
  seat_ids     UUID[] NOT NULL,
  status       TEXT NOT NULL,   -- active | converted | expired | released
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX holds_user ON holds (user_id, created_at DESC);

-- ADR-009 — idempotency keys. response_code IS NULL means "claimed, still running":
-- the claim happens before the handler so two concurrent requests with one key
-- cannot both execute.
CREATE TABLE idempotency_keys (
  key            TEXT PRIMARY KEY,
  user_id        UUID NOT NULL,
  request_hash   TEXT NOT NULL,
  response_code  INT,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

-- ADR-005 — transactional outbox. Rows are written in the SAME transaction as the
-- state change they describe, which is what removes the DB+Kafka dual write.
-- The relay worker arrives in Phase 4; Phase 1 only guarantees the rows exist.
CREATE TABLE outbox (
  id             BIGSERIAL PRIMARY KEY,
  aggregate_id   UUID NOT NULL,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  request_id     TEXT,
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS holds;
DROP TABLE IF EXISTS seats;
DROP TYPE IF EXISTS seat_status;
