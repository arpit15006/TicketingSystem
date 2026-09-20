# Implementation Status

Single source of truth for phase gates. A phase turns ✅ **only** when every verification command
in `docs/IMPLEMENTATION_PLAN.md` §6 has been executed and its real output recorded below.
Code existing is not "complete". Verified is complete.

Legend: ✅ VERIFIED · 🔄 IN PROGRESS · ⏳ BLOCKED (gated by an earlier phase) · ⛔ BLOCKED (external)

| Phase | Name | Status |
|---|---|---|
| Phase 0 | Repository / architecture audit | ✅ VERIFIED |
| Phase 1 | Reservation core ★ | ✅ VERIFIED |
| Phase 2 | Identity + Catalog + Gateway | ✅ VERIFIED |
| Phase 3 | Orders + Razorpay | ✅ VERIFIED |
| Phase 4 | Kafka + outbox + notification | ✅ VERIFIED |
| Phase 5 | Waiting room | ✅ VERIFIED |
| Phase 6a | Frontend enablement (backend) | ✅ VERIFIED |
| Phase 6b | Frontend (Next.js `apps/web`) | ✅ VERIFIED — every PRD §13 route, every role exercised in a real browser |
| Phase 7 | Proof + chaos + load | 🟡 **MOSTLY VERIFIED** — infra, chaos, trace and runbook done; k6 numbers not representative (see report) |
| Phase 8 | Segmented allocation | ✅ VERIFIED |

## Invariant verification status

| ID | Invariant | Proven by | Status |
|---|---|---|---|
| INV-1 | No seat sold twice | `oversell.spec.ts`, `finalize.spec.ts` | ✅ PROVEN — 1000 vs 100 → 100/900, `oversell_total 0` |
| INV-2 | No simultaneous duplicate holds | `oversell.spec.ts`, `basket-atomicity.spec.ts` | ✅ PROVEN — one hold per seat, no overlapping live holds |
| INV-3 | No capture without a sold seat | `expiry-boundary.spec.ts` | ✅ PROVEN — finalize precedes capture; 0 captures when the seat is lost |
| INV-4 | No sold seat without captured payment | `expiry-boundary.spec.ts` | ✅ PROVEN — compensation releases or refunds and never leaves a sold unpaid seat |
| INV-5 | Expired hold never blocks a buyer | `expiry.spec.ts` | ✅ PROVEN — janitor disabled throughout |
| INV-6 | Idempotent replay has no extra effects | `idempotency.spec.ts`, `webhook-replay.spec.ts` | ✅ PROVEN — 50 replays (sequential AND concurrent) → 1 ticket, 1 capture |
| INV-7 | Correctness independent of Redis/Kafka/jobs | `chaos-redis.spec.ts` + `chaos-kafka.spec.ts` | ✅ **PROVEN** — 500 requests / 50 seats with Redis dead → 50/450, `oversell_total 0`; and seats allocate with Kafka dead. Janitor disabled in every test. |
| INV-8 | No overlapping sold occupancy (segmented) | `segment-allocation.spec.ts` | ✅ **PROVEN** — 500 concurrent overlapping requests → 50/450, zero overlapping live occupancies; `EXCLUDE` rejects a hand-inserted conflict with `23P01` |

---

## PHASE 0 VERIFICATION REPORT

**Implementation**
- [x] `PRD.md` read completely (796 lines, §1–§19)
- [x] `DECISIONS.md` read completely (294 lines, ADR-001 … ADR-018 + limitations + 100× notes)
- [x] Entire repository inspected — only the two source-of-truth documents exist; no code, no config, no git
- [x] Package manager, TypeScript, Docker, database, test and CI configuration inspected — **none present**
- [x] Toolchain probed (Node, pnpm, container runtimes, Postgres, Redis, Java, k6, compilers, network)
- [x] Phase dependency graph built (`IMPLEMENTATION_PLAN.md` §2)
- [x] Acceptance criteria, invariants, mandatory tests, guardrails and ADR rationales enumerated
- [x] `docs/ENVIRONMENT_AUDIT.md` written
- [x] `docs/IMPLEMENTATION_PLAN.md` written (phases, dependencies, files, tests, verification commands, risks, invariant matrix)
- [x] `docs/IMPLEMENTATION_STATUS.md` written (this file)

**Tests** — none applicable; no application code exists at Phase 0 by design.

**Acceptance criteria**
- [x] Audit complete before any application code was written
- [x] Implementation plan produced
- [x] Ambiguities/blockers identified explicitly rather than silently invented around (R1, DEV-1 … DEV-4)

**Regression** — not applicable (no prior phase).

**Commands executed**

```bash
ls -la                                  # only PRD.md, DECISIONS.md
git status                              # fatal: not a git repository
node -v ; pnpm -v ; npm -v ; corepack -v
for c in docker podman colima nerdctl lima orbstack; do command -v $c; done
psql --version ; redis-server -v ; k6 version ; java -version ; brew --version
uname -m ; sysctl -n machdep.cpu.brand_string
npm ping ; curl -sI https://github.com ; curl -sI https://repo1.maven.org/maven2/io/zonky/test/postgres/
node scratchpad/pgspike/spike.mjs       # real PostgreSQL 16 feasibility spike
```

**Results**

```
node v24.18.0 · pnpm 10.34.5 · npm 11.16.0 · corepack 0.35.0
arm64 · Apple M5 · Darwin 27.0.0 · clang 21.0.0 · make present · 279 GiB free
git: fatal: not a git repository

docker    : MISSING          podman    : MISSING
colima    : MISSING          nerdctl   : MISSING
lima      : MISSING          orbstack  : MISSING
psql/postgres/initdb : MISSING   redis-server : MISSING
k6 : MISSING                 java : MISSING ("Unable to locate a Java Runtime")
brew : MISSING

npm registry PONG 484ms · github 200 · maven central 200

--- real PostgreSQL feasibility spike ---
LOG:  starting PostgreSQL 16.14 on x86_64-apple-darwin24.6.0, compiled by Apple clang 17.0.0
LOG:  database system is ready to accept connections
VERSION: PostgreSQL 16.14 on x86_64-apple-darwin24.6.0
EXCLUDE constraint + btree_gist: CREATED
DISJOINT segments [0,3) + [3,7): BOTH ACCEPTED (capacity win)
ERROR:  conflicting key value violates exclusion constraint "no_sold_segment_overlap"
DETAIL: Key (seat_id, leg_range)=(…, [2,5)) conflicts with existing key (…, [0,3)).
OVERLAP [2,5): REJECTED by DB → 23P01 no_sold_segment_overlap
Conditional allocation UPDATE returned rows: 1
SPIKE OK
```

**Known issues (status at time of writing; R1/DEV-4 closed shortly afterwards — see
`ENVIRONMENT_AUDIT.md` §6, Docker Desktop 29.8.0 installed by the user)**
- **R1 — no container runtime.** Blocks Testcontainers (PRD §15.1), Redpanda (Phase 4),
  the Redis chaos test (Phase 5) and `docker compose up` (PRD §17, final acceptance). Escalated
  to the user. Does **not** block Phases 1–3.
- **DEV-1** local Node 24 vs PRD's Node 22 LTS (images pin `node:22`).
- **DEV-2** local integration tests use embedded **real** PostgreSQL 16.14; Testcontainers used
  where a Docker daemon exists. Both are a real server — no infrastructure is mocked.
- **DEV-4** no load-test numbers may be produced locally (Rosetta-emulated Postgres).

**Decision**

**PHASE 0 VERIFIED — PROCEED TO PHASE 1**

Phase 1 is Postgres-only on the correctness path and is therefore fully provable on this machine,
including the 1,000-concurrent-request oversell gate. R1 is not a Phase 1 blocker.


---

## PHASE 1 VERIFICATION REPORT

**Implementation**
- [x] pnpm workspace monorepo (`apps/*`, `packages/*`), pinned `packageManager`
- [x] TypeScript strict **with `noUncheckedIndexedAccess`** (plus `exactOptionalPropertyTypes`), adopted from the first commit
- [x] `packages/logger` — Pino factory, redaction paths (PRD §14), named log events, `withRequestId`
- [x] `packages/contracts` — shared types, topic/event names, error codes; **no runtime logic**
- [x] `packages/http` — requestId plugin, error handler, idempotency runner, Phase-1 identity extractor
- [x] `packages/testkit` — real-PostgreSQL provider (Testcontainers ∥ embedded), per-suite database + real migrations, **real parallel HTTP concurrency harness**
- [x] `apps/reservation` — Fastify 5, raw SQL via `pg`, **no ORM**
- [x] Migrations (`node-pg-migrate`, raw `.sql`): `seat_status`, `seats`, `seats_one_order_per_sold_seat`, `seats_availability`, `holds`, `idempotency_keys`, `outbox`, `outbox_unpublished`
- [x] `POST /reservations` — all-or-nothing basket + general admission (`FOR UPDATE SKIP LOCKED`)
- [x] `DELETE /reservations/:id` — release
- [x] `POST /reservations/:id/finalize` — §8.3 conditional sale, `410 Gone` on loss, `SeatSold` written to outbox **in the same transaction**
- [x] `PATCH /holds/:id/extend`, `GET /availability`, `GET /healthz`, `GET /readyz`
- [x] `GET /metrics` exposing `oversell_total` (PRD §6) backed by a real SQL invariant audit
- [x] Idempotency: claim-before-execute, body hash, `422` on key reuse with a different body
- [x] Hold expiry as a **query predicate**; janitor present, cosmetic, disabled in all tests
- [x] `.env.example`, CI workflow with the job named `does_not_oversell` (PRD §15.4)
- [x] README carrying the real oversell output (PRD §16 Phase 1 acceptance)

**Tests — 32 passing across 7 files**

- [x] `oversell.spec.ts` ★ — 1,000 concurrent vs 100 seats, reserved + general admission
- [x] `idempotency.spec.ts` — 5 cases incl. concurrent same-key and deliberate-409 replay
- [x] `expiry.spec.ts` — 5 cases incl. availability predicate and expired-hold extension refusal
- [x] `finalize.spec.ts` — 5 cases incl. `410`, partial-basket rollback, double-finalize
- [x] `basket-atomicity.spec.ts` — 5 cases incl. 200 contenders for one 4-seat basket
- [x] `migration.spec.ts` — 5 cases incl. reversibility (down then up)
- [x] `idempotency-hash.spec.ts` (unit) — 5 cases on canonical hashing

**Acceptance criteria (PRD §16 Phase 1)**
- [x] `oversell.spec.ts` passes: **exactly 100 × 201, exactly 900 × 409, zero oversells**
- [x] Post-run SQL: 100 seats `held`, 0 `sold`, one hold per seat, no overlapping live holds, 100 `SeatHeld` outbox rows
- [x] `oversell_total` reads `0`
- [x] Output pasted into the README **before** any Phase 2 file was created

**Regression** — not applicable (first implementation phase). Determinism checked instead:
the full suite was run **four consecutive times**, 32/32 each time, `{"201":100,"409":900}` each time.

**Guardrails audited (PRD §19)**
- [x] No ORM anywhere — `pg` with hand-written SQL
- [x] Redis not used at all; correctness is Postgres-only
- [x] No background job on the correctness path (janitor off in every test)
- [x] Gateway is not an authorization point (no gateway yet; Phase 1 does no authorization)
- [x] No service queries another service's database
- [x] Concurrency is real parallel HTTP, never simulated inside one transaction
- [x] No `sleep()` in any test — expiry is forced by writing a past timestamp
- [x] No invented numbers: every figure in the README is copied from real output

**Commands executed**

```bash
pnpm install
pnpm typecheck        # tsc -p tsconfig.json --noEmit
pnpm lint             # eslint .
pnpm build            # tsc -b across 5 workspace projects
pnpm test             # full suite, real PostgreSQL via Testcontainers
pnpm vitest run --project integration oversell
```

**Results**

```
typecheck : clean (no output)
lint      : clean (no output)
build     : 5/5 workspace projects built

──────── OVERSELL PROOF ────────
requests fired      : 1000 (real parallel HTTP)
seats available     : 100
status counts       : {"201":100,"409":900}
client latency (ms) : p50=140.2 p95=200.9 p99=202.3 max=202.8
kernel connect retries: 0
peak concurrent allocations in-flight: 128
oversell_total      : 0  ✅
GA status counts    : {"201":100,"409":900}

 Test Files  7 passed (7)
      Tests  32 passed (32)

determinism: 4 consecutive full runs → 32/32 each; peak in-flight 128 / 93 / 92 / 108
```

**Defects found and fixed during this phase** (recorded because they are the useful part)

1. **Real bug — 409 named the wrong seats.** The unavailable-seat list was computed by re-querying
   inside the same transaction, *after* the partial `UPDATE`, so it read our own uncommitted writes
   and reported every seat in the basket as taken. Fixed by deriving the lost seats from the rows
   the `UPDATE` did not return, which is both correct and one query cheaper.
2. **Test-harness bug — leaked pool.** The service pool was never closed before `DROP DATABASE …
   WITH FORCE`, which terminated live backends and surfaced as an uncaught `57P01`.
3. **Test bug — unscoped assertion.** Two `finalize` assertions counted `sold` seats across the whole
   database and picked up rows an earlier test had legitimately sold. Scoped to the event.
4. **Environment artifact — not an application defect.** Opening 1,000 sockets overflows the macOS
   kernel accept queue (`kern.ipc.somaxconn` = 128, unraisable without root); the RSTs also triggered
   an undici `setTypeOfService EINVAL` that hung a run. The harness now issues all 1,000 requests at
   once over a backlog-safe connection pool. This made the proof **stronger**, not weaker: connect
   retries fell 5,532 → 0 and peak concurrent in-service allocations rose 83 → 128.

**Known issues**
- Phase 1 has no authentication; `POST /reservations` attributes the caller from `x-dev-user-id`,
  env-gated by `ALLOW_DEV_IDENTITY_HEADER`. Phase 2 replaces it with RS256 verification and flips the
  gate off. Recorded so the switch-off is a visible, testable event.
- `seats_one_order_per_sold_seat` is specified by PRD §7.1 and implemented verbatim, but since
  `seat_id` is the primary key it cannot admit a row the PK would not. The structural guarantee of
  INV-1 here is that a seat is one row with at most one `order_id`. Noted in the migration rather
  than silently "improved" — the PRD is authoritative. The constraint that does load-bearing work
  against double-issue is `tickets.seat_id UNIQUE` (Phase 3) and the GiST `EXCLUDE` (Phase 8).

**Decision**

**PHASE 1 VERIFIED — PROCEED TO PHASE 2**


---

## PHASE 2 VERIFICATION REPORT

**Implementation**

*identity (:3001)*
- [x] `POST /auth/register` — argon2id (19 MiB / t=2 / p=1), CITEXT email uniqueness, attendee granted on signup
- [x] `POST /auth/login` — identical response for wrong password and unknown user (no enumeration oracle)
- [x] **RS256** access tokens, **10-minute** TTL, claims `sub`/`roles[]`/`jti`/`iat`/`exp`
- [x] Opaque 32-byte refresh tokens, stored only as SHA-256, **14-day** TTL, **rotated on every use**
- [x] **Family reuse detection** — a re-presented rotated token revokes the whole `family_id`
- [x] `jti` denylist behind a `TokenDenylist` interface (in-memory now; Redis in Phase 5, per ADR-011)
- [x] `GET /.well-known/jwks.json` — public half only; identity verifies against its own in-process key rather than calling itself
- [x] `POST /users/:userId/roles` — platform-admin-only role grants
- [x] `BOOTSTRAP_ADMIN_EMAIL` so the first admin exists without a seed script touching identity's database

*catalog (:3002)*
- [x] `venues`, `events` (`draft|published|onsale|closed`, `onsale_at`, `waiting_room_enabled`), `seat_tiers`, `seatmap_sections`, `outbox`
- [x] Venue/event/tier/section CRUD, public browse, seatmap geometry endpoint
- [x] Publishing refuses an event with no pricing tier
- [x] **Never writes or reports seat state** — asserted by a test that greps the seatmap response for seat-state fields

*gateway (:3000)*
- [x] Routing to identity, catalog, reservation (+ orders/queue prefixes ready for Phases 3 and 5)
- [x] **Signature-only** JWT verification against JWKS; forwards no identity headers at all
- [x] `requestId` minted at the edge, returned as `x-request-id`, forwarded on every upstream call
- [x] Rate limiting with `retry-after`

*cross-cutting*
- [x] `authPlugin` + `requirePermission(action, resolver)` in `packages/http`; **every service verifies tokens itself** (ADR-010)
- [x] Resource-scoped permissions: `ACTION_SCOPE` distinguishes global / own / event / venue
- [x] Shared `pg` helpers consolidated into `packages/http`; reservation refactored onto them with no behaviour change
- [x] `POST /inventory/:eventId/seats` — seat provisioning, which only reservation may do
- [x] `pnpm seed` — demo organizer, venue, on-sale event, **5,000 seats**, fully API-driven and idempotent

**Tests — 68 passing across 12 files (was 32 across 7)**

- [x] `refresh-reuse.spec.ts` (6) — **mandatory PRD §15.1 test**: rotation, family revocation, blast-radius limit, no plaintext at rest, logout
- [x] `auth.spec.ts` (10) — argon2id prefix asserted, RS256 header/claims, 600s TTL, enumeration parity, JWKS leaks no private material, tampered token rejected
- [x] `catalog.spec.ts` (10) — resource-scoped authorization incl. cross-organizer denial and grant spillover, venue-scoped seatmap writes, no seat state leakage
- [x] `end-to-end.spec.ts` (7) — **Phase 2 acceptance**, plus direct-to-service auth and forged-header tests
- [x] `seed-and-limits.spec.ts` (3) — the real seed script run as a subprocess, re-run safety, rate limiting
- [x] Phase 1 suites (32) — unchanged and passing

**Acceptance criteria (PRD §16 Phase 2)**
- [x] Registration, login, refresh, refresh rotation, **refresh reuse detection**
- [x] JWKS served and consumed by other services
- [x] Resource-scoped authorization (an organizer cannot touch another organizer's event)
- [x] Gateway routing
- [x] `requestId` propagation (inbound id preserved; minted when absent)
- [x] Catalog functionality
- [x] **5,000-seat seed**
- [x] **Authenticated reservation through the gateway**

**Regression**
- [x] All Phase 1 tests pass — 100 × `201`, 900 × `409`, `oversell_total 0`
- [x] Phase 1 tests now authenticate with **real RS256 tokens** instead of the dev header, so the regression is stronger than before
- [x] Full suite run three times: 68/68 each time, `{"201":100,"409":900}` each time

**Guardrails audited (PRD §19)**
- [x] No ORM
- [x] Redis still absent from the system entirely
- [x] No background job on the correctness path
- [x] **Gateway makes no authorization decision** — it verifies a signature and forwards nothing about identity
- [x] No service queries another service's database; the seed uses only the public API
- [x] No invented numbers

**Commands executed**

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm test
pnpm vitest run --project integration apps/identity
pnpm vitest run --project integration apps/catalog
pnpm vitest run --project integration apps/gateway
```

**Results**

```
typecheck : clean      lint : clean      build : 8/8 workspace projects

 Test Files  12 passed (12)
      Tests  68 passed (68)
   Duration  4.19s

oversell regression : {"201":100,"409":900}, peak in-flight 120, oversell_total 0
determinism         : 3 consecutive full runs, 68/68 each
```

**Defects found and fixed during this phase**

1. **Seed was not idempotent.** Re-running created a second venue, event and another 5,000 seats (the test caught 10,000). `ON CONFLICT` only protected within one event. The seed now looks for the demo event first and reuses it.
2. **Identity fetched its own JWKS over HTTP** using its configured port, which is wrong whenever the service is bound somewhere else (every test). It now verifies against the key already in memory, via a new `localJwks` option.
3. **Unavailable-seat list / routing** — `/inventory/:eventId/seats` replaced a path that collided with the gateway's `/reservations` prefix rewriting.
4. **Client bug surfaced by the stack test** — sending `content-type: application/json` on a bodiless `DELETE` is rejected by Fastify, correctly. Fixed in the test client rather than loosening the server.

**Deviations recorded**

- **DEV-5** — PRD §7.3 specifies `PRIMARY KEY (user_id, role, resource_type, resource_id)` on `role_assignments` while also requiring `resource_type` to be `NULL` for global roles. Postgres makes every primary-key column `NOT NULL`, so a global grant could not be stored. Implemented with a surrogate key plus two partial unique indexes, preserving the intended uniqueness exactly, with the reasoning in the migration.
- **DEV-6** — the `jti` denylist is in-process rather than Redis, because Redis does not enter the system until Phase 5. Behind the `TokenDenylist` interface, and honestly weaker (not shared between replicas) until then. No seat-correctness invariant depends on it (INV-7).

**Known issues**
- The dev identity header still exists but now defaults to **off** and grants no permissions; `requirePermission` ignores it entirely, so a caller using it can do nothing that needs a role.
- Rate limiting is per-gateway-instance until Redis lands in Phase 5.

**Decision**

**PHASE 2 VERIFIED — PROCEED TO PHASE 3**


---

## PHASE 3 VERIFICATION REPORT

**Implementation**
- [x] Order state machine: `created → awaiting_payment → payment_authorized → confirmed`, plus `compensating → refunded_seat_lost`, `failed`, `cancelled`
- [x] `orders`, `processed_webhooks`, `tickets` (**UNIQUE seat_id**), `idempotency_keys`, `outbox`
- [x] Partial unique index `orders_one_live_per_hold` — a double-tapped checkout cannot open two payment intents on one hold
- [x] `POST /orders` — `Idempotency-Key`, ownership check, **refuses below 90s of remaining hold**, extends the hold, creates a Razorpay order with `payment_capture: 0`
- [x] `POST /orders/:id/verify` — HMAC of `order_id|payment_id`, then **finalize → capture → confirm**, never the other order
- [x] `POST /orders/webhooks/razorpay` — **raw `Buffer` body, signature verified before anything parses it**
- [x] `x-razorpay-event-id` claimed by INSERT *before* processing; duplicate key ⇒ `200` and no side effects
- [x] Handles `payment.authorized`, `payment.captured`, `payment.failed`, `refund.processed`; **always `200`** for unhandled types
- [x] Compensation path (PRD §10.4) → release or refund → `refunded_seat_lost` → `OrderCompensated` outbox → logged as `payment.after_expiry.compensated`
- [x] Tickets with QR tokens; `GET /orders/:id` owner-scoped
- [x] `requireServiceToken` — finalize, extend and hold lookup are service-to-service only, never reachable with a user token
- [x] **`finalizeHold` made idempotent** in reservation, since at-least-once delivery guarantees repeat calls

**Tests — 97 passing across 16 files (was 68 across 12)**
- [x] `webhook-replay.spec.ts` (6) — **mandatory**: 50 sequential *and* 50 concurrent deliveries → 1 ticket, 1 capture; re-serialised body rejected; unsigned/wrong-secret rejected; unhandled types acknowledged; browser-closed customer still confirmed by webhook alone
- [x] `expiry-boundary.spec.ts` (5) — **mandatory**: seat lost between authorization and finalization → compensated, **0 captures**, clear user message, rival holds the seat, `oversell_total 0`; captured-payment branch refunds; sub-90s refusal; hold extension; late webhook cannot resurrect a compensated order
- [x] `orders.spec.ts` (10) — happy path, idempotent replay, key reuse `422`, duplicate order `409`, buying another user's hold `403`, forged signature, signature for the wrong order, double verify, order privacy, key secret never leaked
- [x] `signatures.spec.ts` (7, unit) — including the re-serialised-body failure that PRD §10.3 calls the most common bug
- [x] Phases 1–2 suites (69) — all unchanged and passing

**Acceptance criteria (PRD §16 Phase 3)**
- [x] `webhook-replay.spec.ts` passes
- [x] `expiry-boundary.spec.ts` passes
- [x] Raw-body signature verification, manual capture, compensation path all proven

**Regression**
- [x] Full suite run **four consecutive times**: 97/97 each, `{"201":100,"409":900}`, `oversell_total 0`

**Guardrails audited (PRD §19)**
- [x] No ORM · no Redis · no background job on the correctness path
- [x] **Webhook body is never parsed before its signature is verified** — the route receives a raw `Buffer`, enforced by an encapsulated content-type parser
- [x] Gateway makes no authorization decision; no service reads another's database
- [x] No invented numbers

**Commands executed**

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm vitest run --project integration webhook-replay
pnpm vitest run --project integration expiry-boundary
pnpm test   # x4
```

**Results**

```
typecheck : clean      lint : clean      build : 9/9 workspace projects

 Test Files  16 passed (16)
      Tests  97 passed (97)

determinism: 4 consecutive full runs, 97/97, zero unhandled errors
```

**Defects found and fixed during this phase**

1. **Production bug — an idle `pg` client error would crash any service.** Surfaced as an
   intermittent non-zero exit on a fully green run (`57P01` during teardown). `Pool` emits
   `error` for idle clients when Postgres restarts, fails over, or terminates backends, and an
   EventEmitter `error` with no listener is an uncaught exception. A database blip would have
   taken down every service at once. `createPool` now always attaches a handler. **This was a
   genuine resilience hole that a flaky test exposed** — worth stating plainly rather than
   retrying the suite until it went green.
2. **Idempotent finalization was missing.** With at-least-once webhooks, a replay would have hit
   an already-converted hold, received `410`, and pushed a *confirmed, paid* order into
   compensation — handing back a seat the customer had paid for. `finalizeHold` now reports
   success when the hold is already converted **to that same order**, and still returns `410`
   when the seats went to a different one.

**Known issues / limitations**
- Razorpay has no explicit void endpoint. Declining to capture achieves the same outcome (no money
  moves, the authorization lapses); recorded as `releaseAction: 'authorization_released'` and
  documented under ADR-007. A real refund is used when the payment was already captured.
- Outbound Razorpay calls are not retried idempotently: a network timeout during capture needs
  reconciliation against Razorpay's API. Already listed in `DECISIONS.md` known limitation #7.
- `RAZORPAY_WEBHOOK_SECRET` is not yet set. It is generated in the Razorpay dashboard and is a
  *different* secret from the API key secret; webhooks against the real Razorpay will fail until
  it is configured. Tests are unaffected — they sign with a real HMAC over a known secret.

**Decision**

**PHASE 3 VERIFIED — PROCEED TO PHASE 4**


---

## PHASE 4 VERIFICATION REPORT

**Implementation**
- [x] `packages/kafka` — producer, consumer, event envelope, **outbox relay**
- [x] Envelope carries `event_id`, `event_type`, `aggregate_id`, `occurred_at`, `request_id` (PRD §11)
- [x] `event_id` derived as `<service>-<outbox row id>` — **stable across retries**, which is what makes consumer dedupe possible at all
- [x] Messages keyed by `aggregate_id`, so per-entity ordering is preserved (PRD §11)
- [x] Relay: `SELECT … WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED` → publish → `UPDATE … published_at` — all in one transaction
- [x] Relay wired into **reservation** and **orders** at boot; `runOnce()` exposed so tests drive it deterministically
- [x] `notification` service (:3006) with `processed_events` + `notifications`, idempotent consumer, unique index `notifications_one_per_event`
- [x] Real **Redpanda** via Testcontainers, with pinned host port so a restarted broker returns on the same address
- [x] Producer drops its connection on send failure so recovery is driven by our retry loop, not by hoping the client heals

**Tests — 106 passing across 18 files (was 97 across 16)**
- [x] `outbox-relay.spec.ts` (7) — publish → consume → exactly one notification; rows marked published only after the broker accepted them; redelivery produces no second notification; stable `event_id` across attempts and namespaced per service; **`requestId` carried through Kafka into the consumer**; per-aggregate ordering; empty-cycle no-op
- [x] `chaos-kafka.spec.ts` (2) — **the Phase 4 acceptance gate**
- [x] Phases 1–3 suites (97) — unchanged and passing

**Acceptance criteria (PRD §16 Phase 4)**

> "Killing the broker for 30s loses zero events; they publish on recovery."

- [x] Broker genuinely stopped (verified by probe, not assumed)
- [x] 25 events written to the outbox during the outage
- [x] 5 consecutive relay cycles fail; **`published` stays 0 and `published_at` stays NULL for all 25**
- [x] **INV-7 proven during the outage** — 20 seats allocated with the broker dead, using the *real* `ACQUIRE_HOLD_SQL` imported from the reservation service
- [x] Broker revived → all 25 publish with no intervention
- [x] Consumer receives each exactly once: `processed_events` = 25, `notifications` = 25, **zero duplicate `event_id`s**

The outage is driven by observed state rather than a fixed 30-second sleep — PRD §19 forbids
`sleep()` in tests, and asserting "five relay cycles failed and nothing was marked published" is
strictly stronger than waiting 30 seconds and hoping something happened.

**Regression**
- [x] Full suite run **four times** (once + three determinism runs): 106/106 each, `{"201":100,"409":900}`, `oversell_total 0`, zero unhandled errors

**Guardrails audited (PRD §19)**
- [x] **No DB + Kafka dual write anywhere** — every event row is written in the same transaction as its state change
- [x] **At-least-once assumed, never exactly-once** — every consumer dedupes on `event_id`
- [x] No ORM · Redis still absent · no background job on the correctness path (the relay is explicitly off the correctness path and proven so)
- [x] No invented numbers

**Commands executed**

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm vitest run --project integration outbox-relay
pnpm vitest run --project integration chaos-kafka
pnpm test   # x4
```

**Results**

```
typecheck : clean      lint : clean      build : 11/11 workspace projects

 ✓ chaos: the Kafka broker dies mid-sale (2 tests) 24278ms
 ✓ transactional outbox and idempotent consumption (7 tests) 5305ms

 Test Files  18 passed (18)
      Tests  106 passed (106)
   Duration  36.55s

determinism: 4 consecutive full runs, 106/106, zero unhandled errors
```

**Defects found and fixed during this phase**

1. **The chaos test could not actually kill the broker.** `StartedTestContainer.stop()` is a no-op
   the *second* time it is called after a `restart()` — testcontainers keeps internal stopped-state
   that `restart()` does not clear. The test reported the broker as down while it was still serving
   traffic. Proven with a standalone spike, then fixed by driving Docker directly through
   `dockerode`. **A chaos test that cannot kill the thing it is chaos-testing is worse than no test
   at all**, so this mattered more than it looked.
2. **A restarted container came back on a different host port** (55023 → 55027), because an
   ephemeral binding is reallocated on restart. Clients pointed at an address that no longer
   existed, and "events never published" looked like a relay bug. The host port is now pinned, which
   also matches reality: a real broker returns on the address it left.
3. **Producer could stay wedged after an outage**, holding stale broker metadata. It now discards
   the connection on any send failure so the next relay cycle reconnects and rediscovers the cluster.

**Known issues / limitations**
- The relay polls every 500 ms, so publish latency is bounded by that. CDC (Debezium) is the
  lower-latency successor, already noted in `DECISIONS.md` limitation #4.
- Published outbox rows are never pruned; a retention job is future work (also in `DECISIONS.md`).
- Consumer failures rethrow so the offset does not advance, which is right for transient failures
  but means a permanently poisonous message would block its partition. A dead-letter topic is the
  standard next step and is not built.

**Decision**

**PHASE 4 VERIFIED — PROCEED TO PHASE 5**


---

## PHASE 5 VERIFICATION REPORT

**Implementation**
- [x] `waitingroom` service (:3005), Redis only — no database
- [x] `POST /queue/:eventId/join` — Redis `ZSET` scored by join time, **`ZADD NX`** so a refresh never costs your place
- [x] `GET /queue/:eventId/status` — polling equivalent of the stream
- [x] `GET /queue/:eventId/position` — **SSE**, pushing `{position, total, estimatedWaitSeconds}` every 2s, switching to an `admitted` event that carries the token; carries `id:` so `Last-Event-ID` resumption works (ADR-016)
- [x] Admitter loop releasing **N users/second** (default 50) via `ZPOPMIN`, batch scaled to the tick so changing the interval cannot silently change the rate
- [x] Admission JWT with claims `{ eventId, admittedAt, exp: +10min }`
- [x] **Enforcement in reservation** (the service that owns the seat) plus edge validation in the gateway
- [x] Redis-backed **`jti` denylist** (ADR-011) replacing the Phase 2 in-process one — DEV-6 closed
- [x] Redis-backed **rate limiting**, shared across gateway replicas
- [x] Redis **seatmap cache** in catalog with Postgres fallback
- [x] `createRedisClient` with `enableOfflineQueue: false` and `withRedisFallback` — the two things that make fail-open real rather than aspirational

**Tests — 118 passing across 20 files (was 106 across 18)**
- [x] `waiting-room.spec.ts` (9) — arrival ordering, stable position across rejoins, head-of-queue admission, wait estimate, booking blocked without a token, admitted user through end to end, token not valid for another event **or another user**, forged token rejected at the edge, non-waiting-room events unaffected, **SSE position → admitted transition**
- [x] `chaos-redis.spec.ts` (3) — **the Phase 5 acceptance gate**
- [x] Phases 1–4 suites (106) — unchanged and passing

**Acceptance criteria (PRD §16 Phase 5)**

> "Acceptance: fail-open chaos test passes."

With **Redis killed** for the entire burst, against a **waiting-room-enabled event** so Redis is
genuinely on the request path:

```
redis          : KILLED before this burst
requests fired : 500 (real parallel HTTP, through the gateway)
seats available: 50
status counts  : {"201":50,"409":450}
oversell_total : 0  ✅  (Redis was down for all of it)
```

- [x] **Zero oversells** — 50 held, no seat under two holds
- [x] Waiting room **fails open** — `degraded: true`, everyone admitted with a real token
- [x] **Seatmap falls back to Postgres** (`x-cache: miss`, still 200)
- [x] Authentication keeps working (denylist fails open, per ADR-011's stated cost)
- [x] Rate limiting degrades instead of 500ing
- [x] Redis revived → queue and cache resume with no restart and no intervention

**Regression**
- [x] Full suite run **four times**: 118/118 each, `{"201":100,"409":900}` and `{"201":50,"409":450}` every time, zero unhandled errors

**Guardrails audited (PRD §19)**
- [x] **Redis is never consulted to decide whether a seat is available** — proven by killing it
- [x] No Redis locks, no Redlock
- [x] No ORM · no background job on the correctness path
- [x] Gateway still makes no authorization decision; admission enforcement is authoritative in the service that owns the seat
- [x] No invented numbers

**Commands executed**

```bash
pnpm typecheck && pnpm lint && pnpm build
pnpm vitest run --project integration waiting-room
pnpm vitest run --project integration chaos-redis
pnpm test   # x4
```

**Results**

```
typecheck : clean      lint : clean      build : 12/12 workspace projects

 Test Files  20 passed (20)
      Tests  118 passed (118)
   Duration  42.72s

determinism: 4 consecutive full runs, 118/118, zero unhandled errors
```

**Defects found and fixed during this phase**

1. **The rate limiter was fail-CLOSED.** `@fastify/rate-limit` defaults `skipOnError` to `false`, so
   any Redis error became a **500 on every request at the edge** — the exact opposite of what
   ADR-012 promises, and worse than having no rate limiter at all. With `enableOfflineQueue: false`
   that included the window while the connection was still being established, which is how the test
   caught it (a `register` call 500ing during the first concurrent burst). Now `skipOnError: true`:
   an unthrottled request reaches an allocator that is correct under any load; a 500 reaches a
   customer who cannot buy a ticket.
2. **Two tests assumed reconnection was instantaneous.** An ioredis client reconnects on its own
   backoff schedule and can still be backing off after the server accepts connections again. That is
   normal client behaviour, so the tests now poll for recovery rather than asserting a timing
   property of ioredis.

**Deviations closed**
- **DEV-6 closed** — the `jti` denylist is now Redis-backed and shared across replicas, as PRD §9.1
  specifies.

**Known issues / limitations**
- Waiting-room fairness is approximate: position is by join timestamp in a sorted set, and a Redis
  failover could disturb ordering. Since it fails open and holds no correctness state, the worst
  case is an unfair queue, never an oversell (`DECISIONS.md` limitation #6).
- Admission tokens are HS256 with a shared secret. Deliberate: the token grants a queue place and no
  authority over a seat, an order or money. Asymmetric keys would buy multi-verifier and revocation
  properties nothing in this flow needs.
- Revocation staleness of up to 10 minutes when Redis is down, per ADR-011's stated cost.

**Decision**

**PHASE 5 VERIFIED**

Phase 6 (frontend) is **on hold at the user's request** — it will not begin without checking in first.


---

## PHASE 6a VERIFICATION REPORT — frontend enablement

Phase 6 was gated on the user, who opened it and chose the two decisions it hinged on: the browser
talks to the gateway **directly** (so CORS lives at the edge), and the three backend routes the
PRD's page list implies but the services never grew get built rather than stubbed.

Splitting 6a out is deliberate. Every item here is a backend change, so it must pass the same gate
as Phases 1–8 *before* a single line of UI depends on it. None of it touches allocation.

**What the audit found**

Reading the real route tables rather than the PRD's intent turned up seven gaps between the eight
pages in §13 and the running system. Five were addressed here; two were judged not worth code:

| # | Gap | Resolution |
|---|---|---|
| 1 | No CORS anywhere — a browser could not call the gateway at all | `@fastify/cors` at the edge, exact-origin allowlist |
| 2 | Gateway owns `:3000`, Next's dev default | `apps/web` moved to `:3007` (notification already owns `:3006`) |
| 3 | `GET /holds/:holdId` is `internalOnly` — a reloaded seat page could not rebuild its countdown | new owner-scoped `GET /reservations/:holdId` |
| 4 | `/scan` had no endpoint at all | new `POST /tickets/scan` |
| 5 | `/organizer` live sales had no aggregate | new `GET /inventory/:eventId/sales` |
| 6 | Notification unreachable from a browser | gateway proxy entry added |
| 7 | `/login`, `/register` missing from §13's page table | frontend-only; no backend change needed |

**The bug found on the way**

`DELETE /reservations/:holdId` called `requireUserId` and then **never compared it to the hold
owner**. Any authenticated caller who learned a hold id could hand another buyer's seats back to
the market — cancelling someone mid-checkout. It could never oversell (the conditional UPDATE still
arbitrates the seat afterwards), so no proof test caught it; it is an authorization failure, not an
allocation one.

It survived because all three existing release call sites happened to use the owner's own token. Two
of them only *appeared* to: `harness.auth()` mints a **fresh random user id on every call**, so
`expiry.spec.ts` and `segment-allocation.spec.ts` were creating a hold as one user and releasing it
as another, and passing because the check was absent. Both now pin one identity across the pair.

The regression test was verified by reverting the fix and watching it fail — `expected 200 to be
403` — before restoring it. A regression test never seen failing proves nothing.

**Implementation**
- [x] `@fastify/cors` registered **before** the rate limiter and both auth hooks, so a preflight cannot spend quota or be answered with a 429
- [x] `allowedHeaders` explicit: `authorization`, `content-type`, `idempotency-key`, `x-admission-token`, `x-request-id`, `last-event-id`
- [x] `x-request-id` in `exposedHeaders` — PRD §14's id is useless if the browser cannot read it
- [x] `CORS_ORIGINS` allowlist, never `*`; `credentials: false` (bearer tokens, no cookies)
- [x] `GET /reservations/:holdId` — owner-scoped; 403 for a stranger, 404 for a missing hold
- [x] `DELETE /reservations/:holdId` — ownership check added (the bug above)
- [x] `GET /inventory/:eventId/sales` — `sold`/`held`/`available`/`total`, authorized by an explicit `organizer:event:<id>` grant, exactly as seat provisioning is
- [x] `SALES_SUMMARY_SQL` reuses the `AVAILABLE_SEATS_SQL` predicate verbatim, so an expired hold counts as available (ADR-003) — a dashboard must not disagree with what a buyer can book
- [x] `POST /tickets/scan` — `ticket:scan` scoped to the event resolved from the ticket; idempotent replay; `scanned_at IS NULL` in the UPDATE makes the write itself the arbiter (ADR-002's shape, one table over)
- [x] Gateway proxy entries for `/tickets` and `/notifications`
- [x] `.env.example` updated; **no secret added** — real Razorpay values stay in the gitignored `.env`

**Tests added** — 21 across three new suites

| Suite | Tests | Covers |
|---|---|---|
| `apps/gateway/test/unit/cors.spec.ts` | 6 | preflight allowed/denied, full header allowlist, exposed request id, preflight spends no rate-limit quota, real requests still limited |
| `apps/reservation/test/integration/hold-ownership.spec.ts` | 6 | owner re-read returns the identical `expiresAt`; 403 for a stranger; 404 for a missing hold; **stranger cannot release, and the seat stays held**; owner still can; expired hold reads as expired |
| `apps/reservation/test/integration/sales-summary.spec.ts` | 4 | three buckets partition the inventory; **an expired hold counts as available while the row still reads `held`**, and agrees with `/availability`; attendee and wrong-event organizer both 403; 404 with no inventory |
| `apps/orders/test/integration/ticket-scan.spec.ts` | 5 | admits once then reports replay with the original timestamp; **20 concurrent scans → exactly 1 admitted**; wrong-event scanner 403 with the ticket untouched; attendee 403; unknown code 403 |

**Verification — executed, real output**

```
pnpm typecheck   → clean
pnpm lint        → clean
pnpm build       → all 11 workspace packages compiled
pnpm test        → Test Files 26 passed (26)
                   Tests      151 passed (151)
```

Regression evidence from that run — every earlier phase's proof still holds, unchanged:

```
──────── OVERSELL PROOF ────────
requests fired      : 1000 (real parallel HTTP)
status counts       : {"201":100,"409":900}
peak concurrent allocations in-flight: 82
oversell_total      : 0  ✅

──────── REDIS CHAOS PROOF ────────
requests fired      : 500 (real parallel HTTP, through the gateway)
status counts       : {"201":50,"409":450}
oversell_total      : 0  ✅  (Redis was down for all of it)

──────── SEGMENT CONCURRENCY PROOF ────────
requests fired : 500 (real parallel HTTP, overlapping legs)
status counts  : {"201":50,"409":450}
```

**Guardrails**
- [x] No ORM — raw SQL throughout, including both new queries
- [x] Redis holds no correctness state — CORS and rate limiting remain edge behaviour, still fail-open
- [x] No Redlock, no lock for allocation — the scan route uses a conditional UPDATE, the same mechanism
- [x] No background reaper — `SALES_SUMMARY_SQL` derives expiry from the predicate, and the janitor is off in every test
- [x] Authorization **not** centralized at the gateway — all three new routes enforce their own permission; the gateway still verifies signature only
- [x] No cross-service database access — the sales aggregate is answered by the service that owns seat state
- [x] Allocation SQL byte-for-byte unchanged

**Honest limits**
- The 20-way concurrent scan is real parallel HTTP, but unlike the oversell proof there is no
  in-flight gauge proving the requests overlapped **inside** the database. The guarantee rests on the
  conditional UPDATE, which is the same mechanism proven under contention elsewhere.
- `GET /inventory/:eventId/sales` is authorized by an explicit `organizer:event:<id>` grant because
  reservation cannot resolve event ownership — that fact lives in catalog. An organizer who created
  an event through catalog therefore needs that grant issued before the dashboard will answer them.
- CORS was verified with `inject`, not a real browser.

**Exit criteria**: ✅ met. Phase 6b (the Next.js app) may proceed.

---

## PHASE 6b VERIFICATION REPORT — the Next.js app

Every route in PRD §13 plus `/login`, `/register` and `/organizer/new`. Verified two ways: the
usual gate (typecheck, lint, build, full suite), and **a real Chrome driven over the DevTools
Protocol** through every role's complete journey against the live compose stack — real gateway,
real CORS, real Razorpay test mode. Server-rendered HTML is only skeletons for these pages, so
`curl` cannot verify them; the browser can.

**What the end-to-end audit found and fixed**

| # | Found | Fix |
|---|---|---|
| 1 | A plain `organizer` could create an event but never provision its seats: reservation needs an `organizer:event:<id>` grant that only a platform admin could issue. Same for `venue_admin:venue:<id>` and seatmap sections. | Catalog → identity internal grant route, inside the creating transaction (Phase 6b backend commit) |
| 2 | Reservation never checked event status: seats on a draft event were holdable via the API | `EVENT_NOT_ON_SALE` gate, failing open when catalog is unreachable |
| 3 | Basket total collapsed to ₹0 the moment a hold succeeded (priced by looking seats up in `/availability`, which returns only free seats) | Tier travels with the selection |
| 4 | Every Pay press sent a fresh `Idempotency-Key`, so the second collided with `orders_one_live_per_hold` — 409 while seats sat held | Key derived from the hold; a second press replays |
| 5 | Checkout re-POSTed `/orders` to recover Razorpay handles after a reload — same collision | `GET /orders/:id` returns the handles |
| 6 | Seats page never sent the admission token for waiting-room events | Read from the queue's sessionStorage; `/seats` without one bounces to `/queue` |
| 7 | Organizer dashboard listed only public events, so drafts were invisible to their owner | `GET /catalog/events/mine` |
| 8 | Listing cards had no venue or price without N+1 calls | Joined into `GET /catalog/events` |
| 9 | Logout left the previous user's name in the header until the disabled query noticed | `resetQueries` instead of `invalidateQueries` |
| 10 | `/login` while signed in showed the form | Redirects home |
| 11 | Compose run without `--env-file` left every secret empty; stack healthy, first payment failed | `pnpm stack:*` scripts carry the flag; header comment explains the trap |

**Screens** — storefront (hero carousel, city + category filters, ⌘K search, cards with venue and
entry price), event detail (poster band, tiers, venue, FAQ, sticky booking card), **SVG seatmap**
with per-tier colours and a hold countdown that survives reload, waiting room over SSE with the
fail-open banner, Razorpay checkout, ticket-style order page with QR codes and the compensation
message, organizer dashboard (sidebar shell, live stats, inventory chart, events table with
publish / put-on-sale / provision actions, six-step create wizard), gate scanner with handheld and
camera input, 404 inside the app chrome.

**Real-browser end-to-end — 55 checks, 55 passed** (`scratchpad/e2e.mjs`, Chrome headless + CDP)

```
anonymous     12 cards · hero · city/category filters · prices · detail · upcoming disabled
              · seatmap renders · organizer/scan walls · 404
attendee      login · 3 seats → ₹36,000 · hold "Held for 8:00" · total survives hold
              · reload restores hold · Pay → /checkout · Razorpay Checkout opens
              · waiting room: /seats → /queue → admitted → /seats · hold with admission token
              · release · not-on-sale hold refused · /login redirects when signed in
organizer2    (plain organizer) dashboard shows own + draft, not others' · live sales · chart
              · wizard: all six steps · new event public, on sale, 488 seats provisioned
scanner       Scan link only · assigned to 7 events · unknown code refused · cannot organize
admin         both links · sees own events
sign out      avatar gone · Sign in back · refresh token cleared
```

**Gate**

```
pnpm typecheck   → clean (repo + web)
pnpm lint        → clean (repo + web; 1 React Compiler warning on the RHF wizard)
next build       → 12 routes
pnpm test        → 176 passed (32 files)
pnpm seed        → 4 accounts, 4 venues, 8 events, 11,392 seats — organizer2's three events and
                   venue created with no admin involved
```

**Guardrails** — client talks only to the gateway (one base URL, in one file); authorization is
never decided in the browser (links are offered, every service re-checks); no cookie, no BFF;
allocation SQL untouched; nothing in the frontend depends on Redis, Kafka or a background job.

**Honest limits**
- Razorpay Checkout is verified to *open* in test mode; completing a payment needs a human on the
  card form, so `confirmed` orders and the scanner's happy path (a real QR) were exercised through
  the API suites (`orders.spec.ts`, `ticket-scan.spec.ts`), not the browser.
- Events have no image or category in the schema (PRD §2); the poster gradient and category chip
  are derived from the title.
- Venues are not listable; the organizer picks from venues their events already reference, or
  creates one.
- The E2E driver lives in the session scratchpad, not the repo — it is a verification tool for
  this environment (hard-coded Chrome path), not a portable test.

---

## PHASE 7 VERIFICATION REPORT (partial — see the load-test caveat)

**Implementation**
- [x] `Dockerfile` — one multi-stage build, `SERVICE` selects the entrypoint, runs as `node`, migrations run at startup and are idempotent
- [x] `infra/docker-compose.yml` — 10 containers, **healthcheck on every one**, `depends_on: service_healthy` throughout
- [x] `infra/init/` — one Postgres instance, five logical databases, **five separate roles, `REVOKE CONNECT ... FROM PUBLIC`**, `citext` and `btree_gist` installed by superuser
- [x] `loadtest/onsale.js` — k6 script that treats `409` as success, asserts `oversell_total` in `teardown()`, and counts connection failures separately from application errors
- [x] `pnpm keys:generate` — a stable RS256 keypair, because an ephemeral one invalidates every live token on restart
- [x] `docs/runbook.md` — 7 procedures, led by "`oversell_total` is non-zero"
- [x] `chaos-reservation.spec.ts` — the last missing chaos test

**Acceptance criteria (PRD §16 Phase 7, §17)**
- [x] **`docker compose up` reaches healthy from a clean checkout with zero manual steps** — all 10 containers healthy
- [x] `pnpm seed` against the live stack → demo organizer, venue, on-sale event, **5,000 seats**
- [x] **A booking completed end to end against the composed stack, including a real Razorpay order** (`order_TeJdYoyvjcEJ4T`) created against their live test API
- [x] **One `requestId` grepped across every service** — gateway → reservation → catalog → orders, 18 correlated log lines
- [x] `oversell_total` exposed and read by the load test itself
- [x] Chaos tests: Redis kill, Kafka kill, reservation-service kill
- [ ] **k6 numbers are NOT representative and are not published as latency** — see below

**The load test, stated honestly**

10,000 virtual users were reached and sustained; 181,052 requests were served; `oversell_total`
read **0** afterwards. That part is a real result and it is the part that matters.

The latency figures are not publishable, and the reason is recorded rather than hidden:

- **164,131 of 181,052 requests (91%) were `429`.** The gateway rate-limits per IP at 300/min by
  default and a load generator is one IP, so the run largely measured the rate limiter.
- **16,322 requests got no HTTP response at all** — macOS caps the listen backlog at
  `kern.ipc.somaxconn` = 128, unraisable without root.
- The load generator and all 10 containers shared one laptop.

`p95 = 15s` is queueing behind a rate limiter on a saturated laptop, not seat-allocation latency.
Publishing it as system performance would be exactly the kind of invented number the brief forbids.
The full analysis and the procedure for a representative run are in
[`loadtest/results/README.md`](../loadtest/results/README.md).

The clean allocation-latency measurement remains the oversell proof: **p50 140ms / p95 201ms /
p99 202ms at 128 concurrent in-service allocations**, which is unaffected by either constraint.

**Defects found during this phase**
1. **Empty environment variables crashed services at boot.** Compose substitutes an unset
   `${VAR:-}` as an **empty string**, and treating that as "configured" sent an empty PEM to jose:
   identity crash-looped on `docker compose up`. Both identity and orders now normalise empty to
   absent, with a regression test.
2. **An ephemeral signing key breaks the platform on restart.** With `JWT_PRIVATE_KEY` unset,
   identity generated a new keypair at boot, invalidating every live token and every cached JWKS —
   observed as 401s from orders while reservation was still accepting the same token. Added
   `pnpm keys:generate`, and shortened the verifiers' JWKS cooldown from 30s to 5s so a genuine key
   rotation recovers in seconds rather than minutes.
3. **Orders correctly refused to boot** in production without `RAZORPAY_WEBHOOK_SECRET`. Not a
   defect — the guard working — but it is why the secret is now generated locally and documented as
   a value that must match the Razorpay dashboard.

**Known gaps**
- The frontend (Phase 6) is on hold at the user's request, so no `web` container is in Compose.
- A representative k6 run needs the load generator on a separate machine from the stack.

**Decision**

**PHASE 7 VERIFIED except the load-test numbers**, which are recorded as not representative rather
than published. Every other acceptance criterion passed against the live composed stack.

---

## PHASE 8 VERIFICATION REPORT

**Implementation**
- [x] `routes`, `route_stops` in catalog; `events.allocation_mode` (`whole` | `segmented`) and `events.route_id`, with a CHECK that a segmented event must have a route
- [x] `seat_occupancies` with `int4range`, a **GiST index**, and `EXCLUDE USING gist (seat_id WITH =, leg_range WITH &&) WHERE (state = 'sold')`
- [x] `SeatAllocator` interface with `wholeSeatAllocator` and `segmentAllocator`
- [x] Row lock on the parent `seats` row as the per-seat mutex; `held_until > now()` inside the `NOT EXISTS`, so expiry stays a predicate
- [x] `POST /reservations` accepts `fromStop`/`toStop`: **required** when segmented, **`422`** when whole
- [x] `GET /availability` accepts a span and uses the overlap query
- [x] `POST /reservations/:id/finalize` — **contract unchanged**, dispatches internally
- [x] Seats sorted before locking, since this path takes several row locks across several statements

**A design decision worth recording:** finalize and release dispatch on the **data** (does this
hold own rows in `seat_occupancies`?) rather than by asking catalog. That keeps finalization — the
step that runs after money is authorized — free of any dependency on catalog being reachable, and
means whole-seat finalization is byte-for-byte the Phase 1 path with no added latency.

**Tests — the five mandatory ones plus three contract tests, all passing**
- [x] `segment-disjoint` — legs `[0,3)` and `[3,7)` on one berth → **both succeed**. The capacity win, proven.
- [x] `segment-overlap` — `[0,5)` vs `[3,7)` → exactly one succeeds, loser leaves no orphan row
- [x] `segment-concurrency` — **500 concurrent overlapping requests across 50 seats → `{"201":50,"409":450}`**, zero overlapping live occupancies
- [x] `segment-exclusion` — bypasses the application entirely, inserts a conflicting sold row, gets **`23P01 no_sold_segment_overlap`**; also asserts a disjoint sold row is accepted, and that a live *held* row overlapping a sold one is accepted by the constraint — which is precisely why the query and row lock exist
- [x] `segment-expiry` — an expired `[0,5)` hold does not block a new `[3,7)` hold, with the stale row still reading `held` and no reaper involved
- [x] Span required/rejected per mode; finalize idempotent and contract-compatible; span-aware availability

**Acceptance criteria (PRD §16 Phase 8)**
- [x] **Every Phase 1 test passes unchanged** — `{"201":100,"409":900}`, `oversell_total 0`
- [x] **Orders, waiting room, Kafka events and the compensation path required ZERO modification.** The only reason `finalize.spec.ts` and `migration.spec.ts` changed at all is that the former gained an idempotency test in Phase 3 and the latter now rolls back all migrations rather than a hardcoded one — neither is a behaviour change to whole-seat mode.
- [x] Whole-seat schema, SQL and behaviour untouched

**Regression (Docker stopped at the user's request, so Postgres-only suites)**
```
 Test Files  11 passed (11)      Tests  66 passed (66)     (integration, embedded real PostgreSQL 16)
 Tests  12 passed (12)                                     (unit)
 typecheck : clean    lint : clean    build : 12/12
```
The Redis, Kafka, orders and full-stack suites were verified green immediately before Docker was
shut down (118/118 across 20 files at the Phase 5 gate, plus Phase 7's chaos and compose runs).
They are unaffected by Phase 8 by construction — it changed no code they touch.

**Decision**

**PHASE 8 VERIFIED**
