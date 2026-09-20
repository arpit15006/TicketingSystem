# Implementation Plan — Distributed Event Ticketing Platform

Derived from `PRD.md` (§1–§19) and `DECISIONS.md` (ADR-001 … ADR-018). Those two documents are
authoritative; where this plan appears to disagree with them, they win and this plan is the bug.

Companion documents:
- `docs/ENVIRONMENT_AUDIT.md` — Phase 0 audit, toolchain findings, deviation register
- `docs/IMPLEMENTATION_STATUS.md` — live phase gate status

---

## 1. The one thing this project is

> **A seat must never be sold twice.**

Six services are the setting, not the goal. The deliverable is the *proof* that INV-1…INV-8 hold
under concurrency, duplicate requests, expiry races, and infrastructure failure. Every phase below
is gated on evidence, not on code existing.

Mechanism, stated once, because every later phase depends on it being understood:

```sql
-- PRD §8.1 — the lock IS the data (ADR-002). No Redlock, no lease, no fencing token.
UPDATE seats
SET status = 'held', hold_id = $1,
    held_until = now() + ($2 || ' seconds')::interval,
    version = version + 1, updated_at = now()
WHERE seat_id = ANY($3)
  AND (status = 'available' OR (status = 'held' AND held_until < now()))
                                --  ^^^ PRD §8.2 / ADR-003: expiry is a PREDICATE, not a job
RETURNING seat_id;
```

Rows returned < rows requested → roll back the whole basket → `409`. No partial baskets.

---

## 2. Phase dependency graph

```
Phase 0  Audit + plan                      ← no dependencies
   │
Phase 1  Reservation core  ★ THE GATE      ← depends: 0
   │      (monorepo, logger, http, testkit, reservation svc, oversell.spec)
   ├──────────────┬───────────────────────────────┐
Phase 2  Identity/Catalog/Gateway          Phase 4 needs 1+3 only for orders outbox
   │      ← depends: 1                            │
Phase 3  Orders + Razorpay                        │
   │      ← depends: 1, 2                         │
Phase 4  Kafka + outbox relay + notification  ← depends: 1, 3  ⚠ needs broker
   │
Phase 5  Waiting room (Redis)              ← depends: 2, 4  ⚠ needs Redis
   │
Phase 6  Frontend (Next.js)                ← depends: 2, 3, 5
   │
Phase 7  Proof, chaos, k6, README          ← depends: ALL  ⚠ needs Docker for compose+k6
   │
Phase 8  Segmented allocation (additive)   ← depends: 7 fully verified
```

Hard rule from the brief and PRD §16: **Phase N+1 does not begin until Phase N is VERIFIED** —
meaning every listed command was executed and its real output recorded.

---

## 3. Phase detail

Each phase lists: what is built, which files appear, which tests must pass, the exact verification
commands, and what must remain byte-for-byte unchanged from earlier phases.

### Phase 0 — Audit & plan *(in progress)*

| Item | Detail |
|---|---|
| Builds | Nothing executable. Audit + plan only. |
| Files | `docs/ENVIRONMENT_AUDIT.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/IMPLEMENTATION_STATUS.md` |
| Tests | None (no code exists) |
| Verify | Both source documents read end to end; toolchain probed; real-Postgres spike executed |
| Exit criteria | Plan written; blocking infrastructure question raised with the user |

---

### Phase 1 — Reservation core ★ **the only phase that matters if we stop early**

PRD §16 Phase 1, §7.1, §8.1–8.3, §15.1, §15.2.

**Builds**

- pnpm workspace; TypeScript strict **with `noUncheckedIndexedAccess`**; Vitest; ESLint
- `packages/logger` — Pino factory, `requestId` child-logger helper (PRD §14)
- `packages/contracts` — shared types + event envelope schema, **no runtime logic**
- `packages/http` — Fastify plugin set: requestId, error handler, idempotency, `requirePermission` stub
- `packages/testkit` — `withPostgres()` provider (Testcontainers ∥ embedded-pg, DEV-2) + **real-HTTP concurrency harness** (PRD §15.2)
- `apps/reservation` — Fastify 5, `pg` raw SQL, `node-pg-migrate`
  - migrations: `seat_status` enum, `seats`, partial unique index `seats_one_order_per_sold_seat`,
    `seats_availability`, `holds`, `idempotency_keys`, `outbox` (+ `outbox_unpublished`)
  - `POST /reservations` — basket hold, all-or-nothing, `409` with taken seat list
  - `DELETE /reservations/:id` — release
  - `POST /reservations/:id/finalize` — §8.3 conditional sale, `410 Gone` on loss, **writes `SeatSold` to `outbox` in the same transaction**
  - `PATCH /holds/:id/extend` — needed by Phase 3 §10.1 step 4; schema and endpoint land here
  - `GET /availability`, `GET /healthz`, `GET /metrics` exposing **`oversell_total`** (PRD §6)
  - general-admission path via `FOR UPDATE SKIP LOCKED` (§8.1)
  - cosmetic janitor (60 s) — **explicitly safe to never run** (§8.2)

**Guardrails binding this phase**: no ORM; no Redis on the correctness path; no background job as
the expiry mechanism; the conditional `UPDATE` stays visible raw SQL, not buried behind a builder.

**Tests**

| Test | Proves |
|---|---|
| `oversell.spec.ts` ★ | 1,000 real concurrent HTTP `POST /reservations` vs 100 seats → exactly 100 × `201`, 900 × `409`; then `SELECT count(*) FROM seats WHERE status='held'` = 100 |
| `idempotency.spec.ts` | same key + same body → identical response, one hold; same key + different body → `422` |
| `expiry.spec.ts` | expired hold does not block a new buyer (INV-5), via predicate not reaper |
| `finalize.spec.ts` | finalize after expiry → `410`; happy path → `sold` + outbox row in one txn |
| `basket-atomicity.spec.ts` | partial basket rolls back entirely |
| `migration.spec.ts` | migrations up/down clean; constraints and indexes exist |
| post-test SQL assertions | no seat sold twice; no overlapping holds; exactly 100 held |

**Verification commands**

```bash
pnpm -w typecheck && pnpm -w lint && pnpm -w build
pnpm --filter @ticketing/reservation test:unit
pnpm --filter @ticketing/reservation test:integration
pnpm --filter @ticketing/reservation test:oversell     # ★ the gate
```

**Exit criteria** — all green **and** the real `oversell.spec.ts` output pasted into the README
before any Phase 2 file is created (PRD §16).

**Must remain unchanged afterwards**: the §8.1/§8.3 SQL, the `409`/`410` contracts, the hold
lifecycle. Phase 8 may only *dispatch around* them, never edit them.

---

### Phase 2 — Identity, Catalog, Gateway

PRD §16 Phase 2, §9, §7.3, §7.4.

**Builds** — `identity`: argon2id register/login; **RS256** JWT, 10-min TTL, claims `sub/roles[]/jti/exp/iat`;
opaque 32-byte refresh, hashed at rest, 14-day, **rotated every use**, `family_id` reuse detection
revoking the whole family; `jti` denylist; `GET /.well-known/jwks.json`.
`catalog`: venues, events (`draft|published|onsale|closed`, `onsale_at`, `waiting_room_enabled`),
tiers, seatmap sections; **5,000-seat seed**; never writes seat state.
`gateway`: routing, **signature-only** JWT verification with JWKS cache, requestId generation +
`x-request-id` response header, rate limiting.

**Authorization is per-service (ADR-010).** `requirePermission(action, resourceResolver)` is
resource-scoped; the gateway makes **no** authorization decision and no service trusts an upstream
role header.

**Tests** — register/login; refresh rotation; `refresh-reuse.spec.ts` (family revoked); JWKS fetch +
cache; resource-scoped authz (organizer cannot edit another's event); requestId propagation;
5,000-seat seed count; **authenticated end-to-end hold through the gateway**.

```bash
pnpm -w typecheck && pnpm -w lint && pnpm -w build
pnpm --filter @ticketing/identity test && pnpm --filter @ticketing/catalog test
pnpm --filter @ticketing/gateway test
pnpm test:e2e:authenticated-hold
pnpm --filter @ticketing/reservation test:oversell      # regression — must still pass
```

---

### Phase 3 — Orders + Razorpay

PRD §16 Phase 3, §10, §7.2, ADR-007, ADR-008, ADR-009.

**Builds** — order state machine (`created → awaiting_payment → payment_authorized → confirmed`,
plus `compensating → refunded_seat_lost`, `failed`, `cancelled`); `Idempotency-Key` on `POST /orders`;
**refuse when < 90 s of hold remains** (§10.1.3); hold extension; Razorpay Orders with
`payment_capture: 0`; `POST /orders/:id/verify` HMAC check; **seat finalization *before* capture**;
tickets (`seat_id UNIQUE`); `OrderConfirmed` to outbox in the same transaction.

**Webhook — built first, per PRD §10.3**: raw-`Buffer` content-type parser registered *before*
anything parses JSON; `HMAC_SHA256(rawBody, secret)` vs `x-razorpay-signature` via
`crypto.timingSafeEqual`; `x-razorpay-event-id` inserted into `processed_webhooks` **before**
processing (duplicate key → `200`, no side effects); always `200` on unhandled types.

**Compensation path (§10.4)** — finalize returns `410` → `compensating` → void (or refund if
captured) → `refunded_seat_lost` → `OrderCompensated` → user told their seat was lost and payment
released. Logged as `payment.after_expiry.compensated` with a counter.

**Tests** — `webhook-replay.spec.ts` (same event ×50 → exactly 1 ticket, 1 capture);
`expiry-boundary.spec.ts` (hold expires at T; purchase at T+1ms → `410`; competing hold at T+2ms
succeeds; compensation fires); `idempotency.spec.ts` (orders); duplicate `POST /orders`;
raw-body signature verification incl. a re-serialized body that **must** fail; `< 90 s` refusal.

```bash
pnpm --filter @ticketing/orders test:integration
pnpm --filter @ticketing/orders test:webhook-replay
pnpm --filter @ticketing/orders test:expiry-boundary
pnpm -w test:regression        # Phases 1–2
```

---

### Phase 4 — Kafka, outbox relay, notification ⚠ *needs a broker*

PRD §16 Phase 4, §11, ADR-005.

**Builds** — Redpanda (single node, no ZooKeeper); `packages/kafka` producer/consumer wrappers +
**outbox relay** (`SELECT … WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`,
every 500 ms); envelope carrying `event_id`, `occurred_at`, `request_id`; partition by aggregate key;
`notification` service with **idempotent consumers** keyed on `event_id` in `processed_events`.

At-least-once only. No exactly-once assumption. **No DB+Kafka dual write anywhere** — the state
change and its outbox row commit atomically or not at all.

**Tests** — outbox row written in the state-change transaction; relay publishes and marks published;
consumer idempotency under duplicate delivery; per-key ordering; `request_id` propagated into
consumer logs; **broker killed for 30 s → zero events lost, all publish on recovery**.

---

### Phase 5 — Waiting room ⚠ *needs Redis*

PRD §16 Phase 5, §12, ADR-012, ADR-016.

**Builds** — Redis `ZSET` scored by join time; queue token; SSE position stream every 2 s with
`Last-Event-ID` reconnect; admitter releasing N/sec (default 50); admission JWT
`{ eventId, admittedAt, exp:+10min }`; gateway enforcement on `/reservations/*` for
waiting-room-enabled events.

**Redis never holds seat state.** **Fail open**: Redis down → everyone through → allocation still
correct (INV-7).

**Tests** — queue ordering; admission rate; SSE reconnect; admission token validation; gateway
enforcement; `chaos-redis.spec.ts` — **kill Redis mid-sale → zero oversells**, waiting room fails
open, seatmap falls back to Postgres.

---

### Phase 6 — Frontend  ⛔ *confirm with the user before starting*

**The user has asked to be consulted before Phase 6 begins.** Do not start the frontend without
checking in first, even if Phase 5 is verified and the gate is otherwise open.

PRD §16 Phase 6, §13, ADR-017. Next.js 15 App Router, Tailwind v4, shadcn/ui, **SVG** seatmap.
Routes: `/`, `/events/[id]`, `/events/[id]/queue`, `/events/[id]/seats`, `/checkout/[orderId]`,
`/orders/[id]` (confirmation **and** compensation state), `/organizer`, `/scan`.
Client talks **only to the gateway**. Hold countdown auto-releases at zero.
Budget: ≤ 15 % of project time (§13) — it must not consume time owed to the proofs.

---

### Phase 7 — Proof, chaos, load, README ⚠ *needs Docker for compose + k6*

PRD §16 Phase 7, §15.3, §18. Ten required proofs:

1. 1,000 concurrent vs 100 seats · 2. Redis failure · 3. reservation-service failure ·
4. webhook replay ×50 · 5. expiry boundary · 6. idempotency · 7. refresh-token reuse ·
8. Kafka failure + recovery · 9. payment compensation · 10. one `requestId` traced end to end.

k6 at 10,000 VUs → p50/p95/p99 + throughput + errors. **Real numbers only** (DEV-4: not from a
Rosetta-emulated local Postgres). README carries the proof section **above** setup, Mermaid
architecture diagram, the allocation SQL inline, "Why not Redlock", the compensation state machine,
the requestId grep, limitations, and 100× notes. Plus `docs/runbook.md`
("oversell_total is non-zero — what do I do").

---

### Phase 8 — Segmented allocation *(strictly additive)*

PRD §8.4, §16 Phase 8, ADR-018. **Only after 1–7 are verified.**

`routes` / `route_stops` / `allocation_mode` / `route_id` in catalog; `seat_occupancies` with
`int4range`, GiST index and `EXCLUDE … WHERE (state='sold')`; `SeatAllocator` interface with
`WholeSeatAllocator` + `SegmentAllocator`; row lock on the parent `seats` row as the per-seat mutex;
`held_until > now()` stays inside the `NOT EXISTS` — expiry remains a predicate.

Never write an `EXCLUDE` predicate referencing `now()` (not `IMMUTABLE`). Sold-vs-sold is the DB's
job; held conflicts are the query's job, serialized by the row lock.

Five required tests: `segment-disjoint`, `segment-overlap`, `segment-concurrency` (500 concurrent),
`segment-exclusion` (bypass the app layer, prove `23P01`), `segment-expiry`.

**Acceptance: every Phase 1–7 test passes unchanged, and orders / waiting room / Kafka /
compensation require zero modification.** If they need changes, the abstraction is wrong — fix the
abstraction, not the tests.

---

## 4. Invariant → mechanism → test matrix

Maintained for the life of the project; status column updated only by real command output.

| ID | Invariant | Mechanism | Test | Failure mode if broken | Status |
|---|---|---|---|---|---|
| INV-1 | A seat is never `sold` for more than one order | Conditional `UPDATE` (§8.3) + partial unique index + `oversell_total` | `oversell.spec.ts`, `finalize.spec.ts` | Two buyers, one seat — the project's defining failure | ⏳ Phase 1 |
| INV-2 | A seat is never `held` by two holds at once | Conditional `UPDATE` (§8.1), row lock, all-or-nothing basket | `oversell.spec.ts`, `basket-atomicity.spec.ts` | Double hold → double checkout attempt | ⏳ Phase 1 |
| INV-3 | Money never captured without a `sold` seat | Finalize **then** capture; manual capture (ADR-007) | `expiry-boundary.spec.ts`, `webhook-replay.spec.ts` | Charged for nothing | ⏳ Phase 3 |
| INV-4 | A seat is never `sold` without captured payment | Compensation path (§10.4) → void/refund → `refunded_seat_lost` | `expiry-boundary.spec.ts` | Free seat / revenue loss | ⏳ Phase 3 |
| INV-5 | An expired hold never blocks another buyer | `held_until < now()` predicate (ADR-003), no reaper on the path | `expiry.spec.ts`, `chaos-reservation.spec.ts` | Stranded unsellable inventory at peak | ⏳ Phase 1 |
| INV-6 | Idempotent replay → same result, no extra side effects | `idempotency_keys` + body hash; `processed_webhooks` pre-insert; `processed_events` | `idempotency.spec.ts`, `webhook-replay.spec.ts` | Double booking / double ticket | ⏳ Phase 1 → 4 |
| INV-7 | Correctness never depends on Redis, Kafka or a background job | Postgres-only correctness path; fail-open waiting room | `chaos-redis.spec.ts`, Kafka-kill test, janitor-disabled run | Infra outage becomes an oversell | ⏳ Phase 1 → 5 |
| INV-8 | *(segmented)* No two overlapping **sold** occupancies | GiST `EXCLUDE` + `FOR UPDATE` row lock | `segment-exclusion.spec.ts`, `segment-concurrency.spec.ts` | Two passengers, one berth, same leg | ⏳ Phase 8 *(constraint already proven to fire in the Phase 0 spike)* |

---

## 5. Known risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **No container runtime on this machine** | Blocks Testcontainers (§15.1), Redpanda, `docker compose up`, k6 — i.e. Phases 4, 5, 7 acceptance | Escalated to the user (§7). Phases 1–3 proceed on real embedded Postgres (DEV-2). |
| R2 | Local Postgres runs under Rosetta | Load numbers would be unrepresentative | DEV-4 — no local timings published; empty section beats a fabricated one |
| R3 | Testcontainers ∥ embedded-pg divergence | A test could pass on one path, fail on the other | One `withPostgres()` provider, identical migrations and SQL; CI runs the Docker path |
| R4 | Razorpay is an external dependency with no sandbox credentials supplied | Phase 3 cannot hit the live API | Verify signature/webhook/compensation logic against a local fake honouring Razorpay's exact contract; keep the real client behind one adapter; **never** weaken signature verification for testability |
| R5 | Time-dependent tests (expiry boundary) become flaky | False greens/reds; PRD §19 forbids `sleep()` | Inject a clock; drive expiry by writing `held_until` in the past — never by sleeping |
| R6 | Phase 8 pressures the Phase 1 contract | Would violate the "strictly additive" rule | `SeatAllocator` interface; Phase 1–7 suites must pass **unchanged** as the gate |
| R7 | Frontend over-run | Steals time from the proofs | 15 % cap (§13); thin by design |
| R8 | `noUncheckedIndexedAccess` friction across the monorepo | Slows every phase slightly | Adopt from commit one — retrofitting is far worse |

---

## 6. Standing verification protocol

Run at every phase gate; a phase is VERIFIED only when each line produced real passing output:

```bash
pnpm -w typecheck          # strict, noUncheckedIndexedAccess
pnpm -w lint
pnpm -w build
pnpm -w test:unit
pnpm -w test:integration   # real Postgres, no infrastructure mocks
pnpm -w test:regression    # every prior phase suite
```

Then write `PHASE N VERIFICATION REPORT` into `docs/IMPLEMENTATION_STATUS.md` with commands,
real output, acceptance-criteria checklist, regression results, and a
`VERIFIED — PROCEED` / `FAILED — STOP` decision. Any failure stops the phase: inspect → root-cause
→ fix → rerun the failed test → rerun prior suites → re-verify.

---

## 7. Blocking question for the user

Phases 0–3 need nothing further and start now. Phases 4, 5 and 7 need infrastructure that does not
exist on this machine (R1):

- **Kafka/Redpanda** — no container runtime, and no Java either, so there is no fallback
- **Redis** — buildable from source locally, but the chaos test wants a killable container
- **`docker compose up` from a clean checkout** — a stated final-acceptance criterion (PRD §1.1.1, §17)
- **k6 at 10,000 VUs** — binary is installable, but needs a representative (non-Rosetta) stack

Installing Docker Desktop / OrbStack / colima is a user action. The alternative is that Phases 4–7
are implemented and unit-verified but their *chaos and load acceptance criteria remain unproven*,
which must then be stated plainly in the README rather than papered over.
