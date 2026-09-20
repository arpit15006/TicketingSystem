-- Up Migration
--
-- PRD §7.2 — orders_db.

CREATE TYPE order_status AS ENUM (
  'created', 'awaiting_payment', 'payment_authorized',
  'confirmed', 'compensating', 'refunded_seat_lost',
  'failed', 'cancelled'
);

CREATE TABLE orders (
  order_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL,
  event_id            UUID NOT NULL,
  hold_id             UUID NOT NULL,
  seat_ids            UUID[] NOT NULL,
  amount_paise        BIGINT NOT NULL,
  status              order_status NOT NULL DEFAULT 'created',
  razorpay_order_id   TEXT UNIQUE,
  razorpay_payment_id TEXT,
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX orders_user ON orders (user_id, created_at DESC);
CREATE INDEX orders_hold ON orders (hold_id);

-- One live order per hold. Without this, a double-tapped checkout could create two
-- Razorpay orders against the same seats and authorize payment twice for one hold.
CREATE UNIQUE INDEX orders_one_live_per_hold
  ON orders (hold_id) WHERE status NOT IN ('failed', 'cancelled', 'refunded_seat_lost');

-- PRD §10.3 / ADR-009 — Razorpay's x-razorpay-event-id is inserted BEFORE the event
-- is processed. A duplicate-key violation is the dedupe: it means another delivery
-- of the same event already claimed it.
CREATE TABLE processed_webhooks (
  event_id     TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tickets (
  ticket_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL REFERENCES orders(order_id),
  -- The hard guarantee against double-issue: one ticket per seat, ever. Even if
  -- every guard above were bypassed, a second ticket for a seat cannot be written.
  seat_id    UUID NOT NULL UNIQUE,
  qr_token   TEXT NOT NULL UNIQUE,
  scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tickets_order ON tickets (order_id);

CREATE TABLE idempotency_keys (
  key            TEXT PRIMARY KEY,
  user_id        UUID NOT NULL,
  request_hash   TEXT NOT NULL,
  response_code  INT,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS tickets;
DROP TABLE IF EXISTS processed_webhooks;
DROP TABLE IF EXISTS orders;
DROP TYPE IF EXISTS order_status;
