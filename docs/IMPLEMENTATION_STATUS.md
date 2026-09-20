# Implementation Status

Single source of truth for phase gates. A phase turns ✅ **only** when every verification command
in `docs/IMPLEMENTATION_PLAN.md` §6 has been executed and its real output recorded below.
Code existing is not "complete". Verified is complete.

Legend: ✅ VERIFIED · 🔄 IN PROGRESS · ⏳ BLOCKED (gated by an earlier phase) · ⛔ BLOCKED (external)

| Phase | Name | Status |
|---|---|---|
| Phase 0 | Repository / architecture audit | ✅ VERIFIED |
| Phase 1 | Reservation core ★ | ✅ VERIFIED |
| Phase 2 | Identity + Catalog + Gateway | 🔄 NEXT — Phase 1 gate passed |
| Phase 3 | Orders + Razorpay | ⏳ BLOCKED — awaits Phase 2 |
| Phase 4 | Kafka + outbox + notification | ⏳ BLOCKED — awaits Phase 3 |
| Phase 5 | Waiting room | ⏳ BLOCKED — awaits Phase 4 |
| Phase 6 | Frontend | ⏳ BLOCKED — awaits Phase 5 |
| Phase 7 | Proof + chaos + load | ⏳ BLOCKED — awaits Phase 6 |
| Phase 8 | Segmented allocation | ⏳ BLOCKED — strictly additive, awaits Phase 7 |

## Invariant verification status

| ID | Invariant | Proven by | Status |
|---|---|---|---|
| INV-1 | No seat sold twice | `oversell.spec.ts`, `finalize.spec.ts` | ✅ PROVEN — 1000 vs 100 → 100/900, `oversell_total 0` |
| INV-2 | No simultaneous duplicate holds | `oversell.spec.ts`, `basket-atomicity.spec.ts` | ✅ PROVEN — one hold per seat, no overlapping live holds |
| INV-3 | No capture without a sold seat | `expiry-boundary.spec.ts` | ⏳ not yet proven |
| INV-4 | No sold seat without captured payment | `expiry-boundary.spec.ts` | ⏳ not yet proven |
| INV-5 | Expired hold never blocks a buyer | `expiry.spec.ts` | ✅ PROVEN — janitor disabled throughout |
| INV-6 | Idempotent replay has no extra effects | `idempotency.spec.ts`, `webhook-replay.spec.ts` | 🟡 PARTIAL — proven for reservation; webhooks are Phase 3 |
| INV-7 | Correctness independent of Redis/Kafka/jobs | `chaos-redis.spec.ts` + Kafka-kill | 🟡 PARTIAL — Phase 1 has no Redis/Kafka at all and the janitor is off in every test |
| INV-8 | No overlapping sold occupancy (segmented) | `segment-exclusion.spec.ts` | ⏳ not yet proven in-project — constraint mechanism demonstrated in the Phase 0 spike |

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
