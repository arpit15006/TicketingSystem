-- Up Migration
--
-- PRD §11.1 / ADR-005 — notification_db.
--
-- Kafka delivery is at-least-once, so this consumer MUST be idempotent. The whole
-- correctness story of this service is the `processed_events` table.

CREATE TABLE processed_events (
  -- The envelope's event_id, which is derived from (producer, outbox row id) and
  -- is therefore STABLE across redeliveries. A randomly generated id per publish
  -- attempt would make a retry look like a brand new event.
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE notification_kind AS ENUM (
  'order_confirmed', 'order_compensated', 'payment_failed', 'seat_sold'
);

CREATE TABLE notifications (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        TEXT NOT NULL REFERENCES processed_events(event_id),
  user_id         UUID,
  kind            notification_kind NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  request_id      TEXT,
  -- PRD §2 non-goals: no email deliverability infrastructure. Delivery is a log
  -- line, and this column records when that happened.
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One notification per event, so even a bug in the handler cannot double-send.
CREATE UNIQUE INDEX notifications_one_per_event ON notifications (event_id);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS notifications;
DROP TYPE IF EXISTS notification_kind;
DROP TABLE IF EXISTS processed_events;
