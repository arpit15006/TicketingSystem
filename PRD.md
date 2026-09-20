# PRD — Distributed Event Ticketing Platform

> **For the AI agent building this:** Read this document fully before writing code. Build in the phase order given in §16. Do not skip ahead. Phase 1 must have a passing concurrency test before any other service is written. When a spec here conflicts with your instinct, follow the spec — the design choices are deliberate and documented in `DECISIONS.md`.

---

## 1. What we are building

A production-shaped event ticketing platform (think BookMyShow / Ticketmaster) built as six Node.js microservices. The system sells seats for events. The defining constraint is that **a seat must never be sold twice**, even under thousands of simultaneous purchase attempts, even when services crash, even when Redis is down, and even when a payment settles after the buyer's seat hold has expired.

This is a portfolio project whose primary audience is a senior engineer reviewing the repository. Therefore correctness proofs, failure handling, and documentation are first-class deliverables, not afterthoughts.

### 1.1 Success criteria

The project is complete when all of the following are demonstrably true:

1. `docker compose up` brings the entire system to a healthy state with one command.
2. An automated test fires 1,000 concurrent booking requests at 100 seats; exactly 100 succeed and 900 receive `409 Conflict`. Zero oversells.
3. Killing Redis mid-sale does not cause an oversell.
4. Killing the reservation service while holds are active does not leak seats permanently.
5. Replaying the same Razorpay webhook 50 times issues exactly one ticket.
6. A payment that settles after its hold expired is automatically compensated (voided or refunded) and the user is notified.
7. A single `requestId` can be grepped across all service logs to trace one booking end to end.
8. A k6 load test produces real p50/p95/p99 numbers that appear in the README.

---

## 2. Non-goals

Do not build these. They expand scope without improving the signal:

- Seat recommendations, dynamic/surge pricing, or ML of any kind
- Multi-currency or multi-region support
- A mobile app
- Kubernetes manifests, Helm charts, or a service mesh
- gRPC between services (HTTP + Kafka only)
- Elasticsearch
- Social login / OAuth providers
- An admin CMS beyond the minimal organizer dashboard in §13
- Email deliverability infrastructure (log the email, or use a console transport)
- Quota systems, waitlist/RAC promotion, berth-preference optimisation, or tiered cancellation refund rules. These are relevant to rail ticketing and are deliberately excluded even in segmented mode (§8.4) — domain complexity without distributed-systems depth.

---

## 3. Locked tech stack

Do not substitute anything in this list without being asked.

| Layer | Choice |
|---|---|
| Language | TypeScript (strict mode, `noUncheckedIndexedAccess` on) |
| Runtime | Node.js 22 LTS |
| HTTP framework | Fastify 5 |
| Database | PostgreSQL 16, one logical database per service |
| DB client | `pg` with raw SQL. **No ORM.** |
| Migrations | `node-pg-migrate` |
| Cache / queue state | Redis 7 (`ioredis`) |
| Message broker | Apache Kafka via Redpanda (`kafkajs`) |
| Payments | Razorpay (Orders API, manual capture, webhooks) |
| Logging | Pino (Fastify built-in), `pino-pretty` in dev only |
| Validation | Fastify JSON Schema (`@fastify/type-provider-typebox`) |
| Unit/integration tests | Vitest + Testcontainers |
| Load tests | k6 |
| Frontend | Next.js 15 (App Router), React, TailwindCSS v4, shadcn/ui + Shadcn Studio blocks |
| Orchestration | Docker Compose |
| CI | GitHub Actions |

**Package manager:** pnpm workspaces (monorepo).

---

## 4. Services

Six services. Each owns its own database and never reads another service's tables.

| Service | Port | Owns | Responsibility |
|---|---|---|---|
| `gateway` | 3000 | — | Edge. JWT verification, routing, rate limiting, request ID generation, waiting-room token check |
| `identity` | 3001 | `identity_db` | Users, roles, tokens, refresh rotation, revocation |
| `catalog` | 3002 | `catalog_db` | Events, venues, seatmaps, pricing tiers. Read-heavy. **Never writes seat state.** |
| `reservation` | 3003 | `reservation_db` | Seat inventory, holds, seat state machine. **The only service that decides who gets a seat.** |
| `orders` | 3004 | `orders_db` | Order lifecycle, Razorpay integration, webhooks, compensation |
| `waitingroom` | 3005 | — (Redis only) | Virtual queue, admission tokens, SSE position stream |
| `notification` | 3006 | `notification_db` | Kafka consumer. Confirmations, expiry warnings, refund notices |

### 4.1 Why catalog and reservation are separate

Seatmap reads outnumber seat writes by roughly three orders of magnitude and have completely different consistency requirements — a seatmap can be served from a 5-second-stale cache, a seat allocation cannot be stale by a single millisecond. This boundary must be defended in the README.

---

## 5. Repository layout

```
ticketing/
├── apps/
│   ├── gateway/
│   ├── identity/
│   ├── catalog/
│   ├── reservation/
│   ├── orders/
│   ├── waitingroom/
│   ├── notification/
│   └── web/                  # Next.js frontend
├── packages/
│   ├── contracts/            # Shared TS types + event schemas (no runtime logic)
│   ├── logger/               # Pino factory, requestId child logger helper
│   ├── http/                 # Fastify plugin set: auth, requestId, error handler
│   ├── kafka/                # Producer/consumer wrappers, outbox relay
│   └── testkit/              # Testcontainers helpers, concurrency harness
├── infra/
│   ├── docker-compose.yml
│   └── init/                 # DB bootstrap SQL
├── loadtest/                 # k6 scripts
├── docs/
│   ├── PRD.md
│   ├── DECISIONS.md
│   └── runbook.md
├── .github/workflows/ci.yml
└── README.md
```

---

## 6. Core invariants

These are the properties the system must never violate. Every one of them needs a test.

| ID | Invariant |
|---|---|
| INV-1 | A seat is never in `sold` state for more than one order |
| INV-2 | A seat is never `held` by more than one hold simultaneously |
| INV-3 | Money is never captured without a corresponding `sold` seat |
| INV-4 | A seat is never `sold` without a captured payment |
| INV-5 | An expired hold never blocks another buyer |
| INV-6 | Replaying any webhook or API call with the same idempotency key produces the same result and no additional side effects |
| INV-7 | Seat allocation correctness does not depend on Redis, Kafka, or any background job being available |
| INV-8 | *(segmented mode only)* No seat ever has two overlapping sold occupancies. Enforced by a database `EXCLUDE` constraint, not only by application logic. |

Expose INV-1 as a Prometheus-style counter `oversell_total` on `/metrics` in the reservation service. It must always read `0`.

---

## 7. Data model

### 7.1 `reservation_db` — the critical schema

```sql
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

-- Partial unique index enforcing INV-1 at the database level.
CREATE UNIQUE INDEX seats_one_order_per_sold_seat
  ON seats (seat_id) WHERE status = 'sold';

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

CREATE TABLE idempotency_keys (
  key            TEXT PRIMARY KEY,
  user_id        UUID NOT NULL,
  request_hash   TEXT NOT NULL,
  response_code  INT,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
```

Every service that emits events gets its own `outbox` table with the same shape.

### 7.2 `orders_db`

```sql
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

CREATE TABLE processed_webhooks (
  event_id     TEXT PRIMARY KEY,       -- Razorpay's x-razorpay-event-id
  payload      JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tickets (
  ticket_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL REFERENCES orders(order_id),
  seat_id      UUID NOT NULL UNIQUE,   -- enforces one ticket per seat
  qr_token     TEXT NOT NULL UNIQUE,
  scanned_at   TIMESTAMPTZ
);
```

### 7.3 `identity_db`

```sql
CREATE TABLE users (
  user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- argon2id
  full_name     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_assignments (
  user_id       UUID NOT NULL REFERENCES users(user_id),
  role          TEXT NOT NULL,          -- attendee|organizer|venue_admin|scanner|platform_admin
  resource_type TEXT,                   -- 'event' | 'venue' | NULL for global
  resource_id   UUID,
  PRIMARY KEY (user_id, role, resource_type, resource_id)
);

CREATE TABLE refresh_tokens (
  token_id    UUID PRIMARY KEY,
  user_id     UUID NOT NULL,
  family_id   UUID NOT NULL,            -- rotation family, for reuse detection
  hash        TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
```

### 7.4 `catalog_db`

Tables: `venues`, `events`, `seat_tiers`, `seatmap_sections`. Events carry `status` (`draft | published | onsale | closed`), `onsale_at`, and `waiting_room_enabled BOOLEAN`.

---

## 8. The seat allocation algorithm

This is the heart of the project. Implement exactly as specified.

### 8.1 Acquiring a hold

For reserved seating, a single statement per seat, inside one transaction for the whole basket:

```sql
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
RETURNING seat_id;
```

- If the number of returned rows is less than the number requested, **roll the transaction back** and return `409 Conflict` with the list of seats that were taken. Partial baskets are not allowed.
- Default hold duration: **480 seconds** (8 minutes). Configurable per event.

For general admission (unreserved pools), use a different path:

```sql
SELECT seat_id FROM seats
WHERE event_id = $1 AND tier_id = $2
  AND (status = 'available' OR (status = 'held' AND held_until < now()))
ORDER BY seat_id
FOR UPDATE SKIP LOCKED
LIMIT $3;
```

`SKIP LOCKED` is essential here — without it concurrent buyers serialize behind each other on the same rows.

### 8.2 Expiry is a predicate, never a job

Note that `held_until < now()` appears in the `WHERE` clause. Hold expiry is evaluated at query time. **There is no background reaper on the correctness path.** If the cleanup job dies, nothing oversells and nothing leaks.

A janitor job (every 60s) flips stale rows from `held` back to `available` purely for clean reads and analytics. It must be safe to never run.

```sql
UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
WHERE status = 'held' AND held_until < now() - interval '1 minute';
```

### 8.3 Finalizing a sale

Called by the orders service after payment authorization succeeds. Conditional, same as the hold:

```sql
UPDATE seats
SET status = 'sold', order_id = $1, held_until = NULL, version = version + 1
WHERE seat_id = ANY($2)
  AND hold_id = $3
  AND status = 'held'
  AND held_until > now()
RETURNING seat_id;
```

**If this returns fewer rows than expected, the seat was lost.** Roll back, return `410 Gone`, and the orders service must enter the compensation path (§10.4).

Write the `SeatSold` event into the `outbox` table **in the same transaction** as the seat update.

---

### 8.4 Segment-based allocation (optional mode — Phase 8)

**Build this only after Phase 7 is complete.** It is additive and must not alter the behaviour of whole-seat allocation.

#### The problem

In whole-seat mode a seat is a single indivisible unit: one seat, one buyer. For journey-based inventory (trains, buses, multi-leg transport) that model wastes capacity. A berth on a Delhi → Chennai train can legitimately be sold to one passenger for Delhi → Bhopal and another for Bhopal → Chennai. Availability stops being a boolean and becomes *"is this seat free across every leg the requested journey spans."*

That is an interval-overlap problem, and Postgres can enforce it at the storage layer.

#### Data model

Add to `catalog_db`:

```sql
CREATE TABLE routes (
  route_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name      TEXT NOT NULL
);

CREATE TABLE route_stops (
  route_id      UUID NOT NULL REFERENCES routes(route_id),
  stop_sequence INT  NOT NULL,      -- 0-based, strictly increasing
  stop_name     TEXT NOT NULL,
  PRIMARY KEY (route_id, stop_sequence)
);
```

Events gain `allocation_mode TEXT NOT NULL DEFAULT 'whole'` (`'whole' | 'segmented'`) and a nullable `route_id`.

Add to `reservation_db`:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE seat_occupancies (
  occupancy_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id      UUID NOT NULL REFERENCES seats(seat_id),
  event_id     UUID NOT NULL,
  leg_range    int4range NOT NULL,      -- [boarding_seq, destination_seq)
  state        TEXT NOT NULL,           -- 'held' | 'sold'
  hold_id      UUID,
  order_id     UUID,
  held_until   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT no_sold_segment_overlap
    EXCLUDE USING gist (seat_id WITH =, leg_range WITH &&)
    WHERE (state = 'sold')
);

CREATE INDEX seat_occupancies_lookup
  ON seat_occupancies USING gist (seat_id, leg_range);
```

The range is half-open `[boarding, destination)`. A passenger travelling stops 0→3 occupies `[0,3)`; another boarding at 3 occupies `[3,7)`. These do not overlap, which is exactly right — one alights as the other boards.

In segmented mode the `seats` row carries no `status`, `hold_id` or `held_until`; it is pure identity (coach, berth, tier). All state lives in `seat_occupancies`. Whole-seat mode is untouched.

#### Why the exclusion constraint only covers `sold`

Index predicates in Postgres must be `IMMUTABLE`, and `now()` is not. A partial constraint covering *live* holds (`state='held' AND held_until > now()`) is therefore impossible — the predicate cannot reference the clock.

So correctness is enforced in two layers, and the implementing agent must understand the split:

| Conflict | Enforced by |
|---|---|
| sold vs sold | The `EXCLUDE` constraint — a hard database guarantee, independent of application code |
| held vs sold, held vs held | The allocation query below, serialized by a row lock on the parent `seats` row |

The `EXCLUDE` constraint is the backstop for INV-1. Even a bug in the application layer cannot double-sell a segment; the transaction will abort with a constraint violation. Log any such violation as `segment.exclusion.violated` — it should never fire, and if it does it means the query layer has a hole.

#### Acquiring a segmented hold

Two statements in one transaction. The row lock on `seats` is the serialization point:

```sql
-- 1. Serialize all concurrent allocation attempts for this seat
SELECT seat_id FROM seats WHERE seat_id = $1 FOR UPDATE;

-- 2. Insert only if no live occupancy overlaps the requested legs
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
RETURNING occupancy_id;
```

Zero rows returned means the segment was taken → `409 Conflict`. Same contract as whole-seat mode.

Note that `held_until > now()` appears in the `NOT EXISTS` clause: **expiry remains a predicate** (§8.2). An expired hold on an overlapping leg does not block a new booking, and no reaper is required. The design property from ADR-003 carries over intact.

#### Finalizing a segmented sale

```sql
UPDATE seat_occupancies
SET state = 'sold', order_id = $1, held_until = NULL
WHERE occupancy_id = ANY($2)
  AND hold_id = $3
  AND state = 'held'
  AND held_until > now()
RETURNING occupancy_id;
```

Fewer rows than expected → the segment was lost → `410 Gone` → compensation path (§10.4), unchanged.

#### Availability search

"Which seats are free for stops 2→5 on this event":

```sql
SELECT s.seat_id, s.coach, s.seat_number
FROM seats s
WHERE s.event_id = $1
  AND NOT EXISTS (
    SELECT 1 FROM seat_occupancies o
    WHERE o.seat_id = s.seat_id
      AND o.leg_range && int4range($2, $3, '[)')
      AND (o.state = 'sold'
           OR (o.state = 'held' AND o.held_until > now()))
  )
ORDER BY s.coach, s.seat_number
LIMIT $4;
```

The GiST index makes the overlap check an index scan rather than a sequential one.

#### API surface

| Endpoint | Change |
|---|---|
| `POST /reservations` | Accepts optional `{ fromStop, toStop }`. Required when the event is `segmented`, rejected with `422` when it is `whole`. |
| `GET /availability` | Accepts `fromStop`/`toStop`; returns seats free across that span |
| `POST /reservations/:id/finalize` | Unchanged contract; dispatches internally on allocation mode |

Dispatch on `allocation_mode` behind a single `SeatAllocator` interface with two implementations (`WholeSeatAllocator`, `SegmentAllocator`). The orders service, waiting room, Kafka events and compensation path must require **no changes** — if they do, the abstraction is in the wrong place.

#### Required tests

| Test | Assertion |
|---|---|
| `segment-disjoint.spec.ts` | Two buyers, legs `[0,3)` and `[3,7)`, same seat → **both succeed**. This is the capacity win; prove it. |
| `segment-overlap.spec.ts` | Two buyers, legs `[0,5)` and `[3,7)`, same seat → exactly one succeeds |
| `segment-concurrency.spec.ts` | 500 concurrent requests for overlapping legs across 50 seats → no seat has two overlapping live occupancies |
| `segment-exclusion.spec.ts` | Bypass the query layer and `INSERT` a conflicting `sold` row directly → the transaction aborts on the `EXCLUDE` constraint. Proves the storage-layer backstop is real. |
| `segment-expiry.spec.ts` | An expired hold on `[0,5)` does not block a new hold on `[3,7)` |

`segment-exclusion.spec.ts` is the most interesting of these to a reviewer — it demonstrates defence in depth rather than asserting it.

#### Scope boundary

Build the interval allocation only. Do **not** add quotas, waitlist/RAC promotion, berth-preference optimisation, or tiered cancellation refund rules. Those are domain complexity without distributed-systems depth, and they are explicitly out of scope per §2.

---

## 9. Auth & RBAC

### 9.1 Tokens

- Access token: JWT, RS256, **10 minute** TTL. Claims: `sub`, `roles[]`, `jti`, `exp`, `iat`.
- Refresh token: opaque random 32 bytes, stored hashed, **14 day** TTL, rotated on every use.
- **Reuse detection:** if a refresh token that has already been rotated is presented, revoke the entire `family_id`. This is a real attack mitigation and worth a README paragraph.
- Revocation: `jti` denylist in Redis with TTL equal to remaining access-token lifetime.
- Public key served at `GET /identity/.well-known/jwks.json`. Gateway caches it.

### 9.2 Authorization rules

The gateway verifies the **signature only**. It makes no authorization decisions. Each service enforces its own permissions.

> A service that trusts an upstream header is one misconfigured ingress away from full compromise. State this in the README.

Permissions are resource-scoped:

| Role | Permission | Scope |
|---|---|---|
| `attendee` | `booking:create`, `order:read` | own resources only |
| `organizer` | `event:create`, `event:update`, `event:publish` | events they own |
| `venue_admin` | `venue:*`, `seatmap:*` | venues they administer |
| `scanner` | `ticket:scan` | events assigned to them |
| `platform_admin` | `*` | global |

Implement as a `requirePermission(action, resourceResolver)` Fastify decorator. Flat global roles are not acceptable.

---

## 10. Payments — Razorpay

### 10.1 Flow

1. Client holds seats → receives `hold_id` and `expires_at`
2. Client calls `POST /orders` with the `hold_id` and an `Idempotency-Key`
3. Orders service **rejects the request if less than 90 seconds of hold remain** and asks the client to re-acquire. This bounds the danger window.
4. Orders service extends the hold by calling reservation's `PATCH /holds/:id/extend`, then creates a Razorpay Order with `payment_capture: 0` (**manual capture**)
5. Client completes Razorpay Checkout
6. Client posts `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature` to `POST /orders/:id/verify`
7. Server verifies `HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)` and compares to the signature. **Never trust the client success callback without this.**
8. Server attempts the seat finalization (§8.3)
9. **Only if finalization succeeds**, capture the payment
10. Write `OrderConfirmed` to outbox in the same transaction, issue tickets

### 10.2 Why manual capture

Authorizing without capturing maps exactly onto the hold model. If the seat is lost between authorization and capture, we **void** instead of refunding — no money ever moves, settlement is instant, and the user sees a released authorization rather than a refund pending for 5 days. This is a deliberate design choice and belongs in `DECISIONS.md`.

### 10.3 Webhooks

- Endpoint: `POST /orders/webhooks/razorpay`
- **Raw body required.** Register a Fastify content-type parser that preserves the raw `Buffer` before JSON parsing, or signature verification will fail on key reordering and whitespace. This is the single most common implementation bug — do it first.
- Verify `HMAC_SHA256(rawBody, webhook_secret)` against the `x-razorpay-signature` header. Use `crypto.timingSafeEqual`.
- Insert the `x-razorpay-event-id` into `processed_webhooks` with a unique constraint **before** processing. A duplicate-key violation means already handled → return `200` immediately and do nothing.
- Handle: `payment.authorized`, `payment.captured`, `payment.failed`, `refund.processed`
- Always return `200` for events you don't handle. Never let Razorpay retry because of an unhandled type.

### 10.4 The compensation path

This is the case that separates this project from every other ticketing clone. Implement and test it explicitly.

```
created → awaiting_payment → payment_authorized → confirmed
                                     │
                                     └── seat finalization returned 410
                                          ↓
                                    compensating
                                          ↓
                              void authorization (or refund if captured)
                                          ↓
                                  refunded_seat_lost
                                          ↓
                            emit OrderCompensated → notification
```

The user must receive a clear message: their payment was released, their seat was taken, and here are alternative seats. Log this with a dedicated event name `payment.after_expiry.compensated` and increment a counter.

---

## 11. Events (Kafka)

Topic naming: `ticketing.<aggregate>.<event>`, all with `event_id`, `occurred_at`, `request_id` in the envelope.

| Topic | Producer | Consumers | Key |
|---|---|---|---|
| `ticketing.seat.held` | reservation | analytics | `event_id` |
| `ticketing.seat.sold` | reservation | catalog (availability cache), notification | `event_id` |
| `ticketing.seat.released` | reservation | catalog | `event_id` |
| `ticketing.order.confirmed` | orders | notification | `order_id` |
| `ticketing.order.compensated` | orders | notification | `order_id` |
| `ticketing.payment.failed` | orders | notification | `order_id` |

### 11.1 Outbox relay

A background worker in each producing service:

```
every 500ms:
  SELECT * FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED
  publish each to Kafka
  UPDATE outbox SET published_at = now() WHERE id = ANY(...)
```

Delivery is at-least-once. **Every consumer must be idempotent** — key on `event_id` in a `processed_events` table.

Partition by the key column so events for the same aggregate stay ordered.

---

## 12. Waiting room

Applies only when `event.waiting_room_enabled = true`.

- `POST /queue/:eventId/join` → adds `user_id` to a Redis `ZSET` scored by join timestamp, returns a queue token
- `GET /queue/:eventId/position` → SSE stream pushing `{ position, total, estimatedWaitSeconds }` every 2 seconds
- An admitter loop releases **N users per second** (configurable, default 50) from the head of the ZSET
- On admission, mint a short-lived JWT with claims `{ eventId, admittedAt, exp: +10min }`
- The gateway requires a valid admission token on all `/reservations/*` routes for waiting-room-enabled events
- **Fail open:** if Redis is unavailable, the waiting room lets everyone through. Seat allocation is still correct because Redis holds no correctness state (INV-7).

---

## 13. Frontend (Next.js)

`apps/web`, App Router, shadcn/ui initialised via `npx shadcn@latest init`, Shadcn Studio blocks copied in for layout and dashboard chrome.

Pages:

| Route | Purpose |
|---|---|
| `/` | Event listing |
| `/events/[id]` | Event detail + seatmap |
| `/events/[id]/queue` | Waiting room with live SSE position |
| `/events/[id]/seats` | Interactive SVG seatmap, hold countdown timer |
| `/checkout/[orderId]` | Razorpay Checkout handoff |
| `/orders/[id]` | Confirmation, QR ticket, or compensation message |
| `/organizer` | Dashboard: create event, upload seatmap, live sales |
| `/scan` | Scanner view for `scanner` role |

Rules:
- Seatmap is **SVG**, not canvas — simpler hit detection and accessible.
- Hold countdown shows remaining seconds and auto-releases on hit zero.
- Keep it thin. Do not spend more than 15% of total project time here.
- Client talks only to the gateway. No direct service calls.

---

## 14. Logging (Pino)

- Gateway generates `requestId` (UUID v4) per request, returns it in the `x-request-id` response header
- Every service reads `x-request-id`, falls back to generating one, and binds it: `req.log = logger.child({ requestId, service })`
- Forward `x-request-id` on every outbound HTTP call
- Put `request_id` in the Kafka message envelope so async consumers log under the same ID
- Redact: `req.headers.authorization`, `req.headers["x-razorpay-signature"]`, `*.password`, `*.key_secret`
- Named events to log explicitly: `seat.hold.won`, `seat.hold.lost`, `seat.finalize.failed`, `payment.after_expiry.compensated`, `webhook.duplicate.ignored`, `refresh.reuse.detected`
- `pino-pretty` in dev, raw JSON in production config

---

## 15. Testing requirements

### 15.1 Mandatory proof tests

| Test | Assertion |
|---|---|
| `oversell.spec.ts` | 1,000 concurrent `POST /reservations` against 100 seats → exactly 100 × `201`, 900 × `409`. Then `SELECT count(*) FROM seats WHERE status='held'` = 100. |
| `expiry-boundary.spec.ts` | Hold expires at T. Purchase attempt at T+1ms fails with `410`. Competing hold at T+2ms succeeds. Compensation fires. |
| `webhook-replay.spec.ts` | Same Razorpay event delivered 50× → exactly 1 ticket row, 1 captured payment |
| `idempotency.spec.ts` | Same `Idempotency-Key` + same body → identical response, one hold. Same key + different body → `422`. |
| `chaos-redis.spec.ts` | Kill Redis container mid-sale → zero oversells, waiting room fails open |
| `chaos-reservation.spec.ts` | Kill reservation service holding 50 seats → seats available again after expiry, no manual intervention |
| `refresh-reuse.spec.ts` | Reusing a rotated refresh token revokes the whole family |

All integration tests use **Testcontainers** — a real Postgres, a real Redis, a real Redpanda. No mocks for infrastructure.

### 15.2 The concurrency harness

Put this in `packages/testkit`. It must use real parallel HTTP requests (`Promise.all` over 1,000 `fetch` calls against the running service), not simulated concurrency inside a single transaction.

### 15.3 Load test

`loadtest/onsale.js` — k6 script simulating 10,000 virtual users hitting an on-sale moment. Record p50/p95/p99 for hold acquisition and throughput. Output goes in the README.

### 15.4 CI

GitHub Actions on every push: lint → typecheck → unit → integration (Testcontainers) → the oversell test. The workflow job must be named `does_not_oversell` so the badge reads well.

---

## 16. Build phases

Build in this exact order. Do not start a phase until the previous one's acceptance criteria pass.

### Phase 1 — Reservation core *(the only phase that matters if you stop early)*
- pnpm monorepo, TypeScript config, Pino logger package
- `reservation` service: schema, migrations, `POST /reservations` (hold), `DELETE /reservations/:id` (release), `POST /reservations/:id/finalize`
- Idempotency-key middleware
- **Acceptance: `oversell.spec.ts` passes. Paste the output into the README before continuing.**

### Phase 2 — Identity, catalog, gateway
- `identity`: register, login, refresh rotation with reuse detection, JWKS
- `catalog`: events, venues, seatmaps, seed script generating a 5,000-seat venue
- `gateway`: routing, JWT verification, requestId, rate limiting
- **Acceptance: authenticated end-to-end seat hold through the gateway**

### Phase 3 — Orders & Razorpay
- Order state machine, manual-capture flow, signature verification (raw body first)
- Webhook handler with `processed_webhooks` dedupe
- **The compensation path**
- **Acceptance: `webhook-replay.spec.ts` and `expiry-boundary.spec.ts` pass**

### Phase 4 — Kafka & notification
- Outbox tables and relay worker in reservation + orders
- Redpanda in Compose
- `notification` service consuming with idempotent handlers
- **Acceptance: killing the broker for 30s loses zero events; they publish on recovery**

### Phase 5 — Waiting room
- Redis ZSET queue, token-bucket admitter, SSE position stream, admission JWT
- Gateway enforcement
- **Acceptance: fail-open chaos test passes**

### Phase 6 — Frontend
- Next.js app per §13

### Phase 7 — Proof & polish
- Chaos tests, k6 load run, `oversell_total` metric
- README with architecture diagram, all test outputs, load numbers, and the grep-one-requestId trace
- `docs/runbook.md`: "oversell_total is non-zero — what do I do"
- `docs/DECISIONS.md` (already written — keep it updated if you deviate)

### Phase 8 — Segment-based allocation *(optional, strictly additive)*
- `routes` / `route_stops` in catalog, `allocation_mode` on events
- `seat_occupancies` with the `EXCLUDE` constraint, per §8.4
- `SeatAllocator` interface with whole-seat and segment implementations
- All five segment tests from §8.4 passing
- **Acceptance: every Phase 1–7 test still passes unchanged.** Orders, waiting room, Kafka events and the compensation path must require zero modification. If they don't, the abstraction is wrong — fix the abstraction, not the tests.
- Add a README section showing two passengers sharing one berth across disjoint legs

---

## 17. Docker Compose

One file, `infra/docker-compose.yml`. Requirements:

- Healthchecks on every container; services use `depends_on: { condition: service_healthy }`
- One Postgres 16 container hosting **separate logical databases** per service, each with its own user and no cross-database grants. Document this as a resource-constrained tradeoff versus separate instances.
- Redis 7, Redpanda (single node, no ZooKeeper)
- `.env.example` committed with every variable; real `.env` gitignored
- A `make seed` / `pnpm seed` target that creates a demo organizer, a venue, and an on-sale event with 5,000 seats
- `docker compose up` must reach healthy with zero manual steps

---

## 18. README requirements

The README is a deliverable, not documentation. Structure it in this order:

1. One-paragraph description
2. **The proof section, first, above setup** — the oversell test output, the chaos test results, the k6 numbers
3. Architecture diagram (Mermaid)
4. The seat allocation algorithm, with the SQL shown inline
5. "Why not Redlock" — 2 paragraphs
6. The compensation path state machine
7. A grep of one `requestId` traced across all services, including a compensation case
8. Quickstart
9. Link to `docs/DECISIONS.md`
10. Known limitations and what would change at 100× scale

---

## 19. Guardrails for the implementing agent

- **Never** introduce an ORM. The conditional UPDATE must be visible raw SQL.
- **Never** use Redis for seat state, even as a cache of availability that could be read before a write decision.
- **Never** use a background job as the mechanism that frees expired holds.
- **Never** make the gateway an authorization decision point.
- **Never** parse the webhook body before verifying its signature.
- **Never** let a service query another service's database.
- **Never** let segmented mode (§8.4) change the behaviour, schema or tests of whole-seat mode. It dispatches behind an interface; it does not rewrite the existing path.
- **Never** attempt an `EXCLUDE` constraint whose predicate references `now()`. Index predicates must be `IMMUTABLE`. The constraint covers `state='sold'` only; live holds are handled by the query plus the `FOR UPDATE` row lock.
- Prefer boring, explicit code over clever abstraction. A reviewer reads this in 90 seconds.
- Every non-obvious decision gets a short comment explaining *why*, not *what*.
- If you find yourself writing a `sleep()` in a test, stop and use a deterministic clock or a real container instead.
