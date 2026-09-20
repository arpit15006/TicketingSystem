# Phase 0 — Environment & Repository Audit

Date: 2026-09-20
Auditor: implementing agent (pre-implementation gate)

## 1. Repository state

The repository contains **two files and nothing else**:

| Path | Size | Role |
|---|---|---|
| `PRD.md` | 35.8 KB / 796 lines | Source of truth — product + technical spec |
| `DECISIONS.md` | 24.8 KB / 294 lines | Source of truth — ADR-001 … ADR-018 |

There is **no existing code, configuration, or infrastructure to preserve**:

- No `package.json`, no `pnpm-workspace.yaml`, no lockfile
- No `tsconfig.json`
- No `infra/`, no `docker-compose.yml`, no `.env.example`
- No test configuration, no `.github/workflows/`
- **Not a git repository** (`git status` → `fatal: not a git repository`)

Consequence: there is no risk of "unnecessarily rewriting existing correct infrastructure" —
everything is greenfield, and the PRD §5 layout is adopted verbatim.

## 2. Toolchain present

| Tool | Status | Version | Notes |
|---|---|---|---|
| Node.js | present | **v24.18.0** | PRD §3 locks **Node 22 LTS**. See DEV-1. |
| pnpm | present | 10.34.5 | Matches PRD (pnpm workspaces) |
| npm | present | 11.16.0 | Used only for the toolchain spike |
| corepack | present | 0.35.0 | Will pin pnpm via `packageManager` |
| clang / Xcode CLT | present | clang 21.0.0, arm64-apple-darwin27 | Native builds possible |
| make | present | /usr/bin/make | Source builds possible |
| Network | reachable | — | npm registry, GitHub, Maven Central all 200 |
| Platform | — | macOS (Darwin 27.0.0), **Apple M5, arm64** | |
| Free disk | — | 279 GiB | Not a constraint |

## 3. Toolchain ABSENT — the blocking finding

| Required by PRD | Status | Blocks |
|---|---|---|
| **Docker / Docker Compose** | **MISSING** | PRD §17 (`docker compose up`), §15.1 (Testcontainers), Redpanda, final acceptance |
| Podman / colima / OrbStack / nerdctl / lima | **MISSING** | — no alternative container runtime of any kind |
| PostgreSQL (`psql`, `postgres`, `initdb`) | MISSING as system package | mitigated — see §4 |
| Redis (`redis-server`) | MISSING | Phase 5, rate limiting, `jti` denylist |
| Java runtime | MISSING | removes Apache-Kafka-without-Docker as a fallback |
| k6 | MISSING | Phase 7 load test |
| Homebrew | MISSING | no package-manager path to install the above |

`docker`, `podman`, `colima`, `nerdctl`, `lima`, `orbstack` are all absent from `PATH`;
`/Applications` contains no container runtime; no Docker socket exists at any standard location.

**This is the single most important Phase 0 finding.** PRD §15.1 mandates Testcontainers
("a real Postgres, a real Redis, a real Redpanda. No mocks for infrastructure") and §17
mandates a one-command `docker compose up`. Neither can execute on this machine as it stands.

## 4. Mitigation proven by spike — real PostgreSQL 16 without Docker

Rather than fake the Phase 1 gate, a spike proved a **genuine PostgreSQL 16 server** can run
locally with no Docker, no Homebrew and no root, via the `embedded-postgres` package
(official PostgreSQL binaries repackaged from Maven Central / Zonky).

Spike executed at `scratchpad/pgspike/spike.mjs`. Verified output:

```
VERSION: PostgreSQL 16.14 on x86_64-apple-darwin24.6.0
EXCLUDE constraint + btree_gist: CREATED
DISJOINT segments [0,3) + [3,7): BOTH ACCEPTED (capacity win)
OVERLAP [2,5): REJECTED by DB → 23P01 no_sold_segment_overlap
Conditional allocation UPDATE returned rows: 1
SPIKE OK
```

What this proves is already available before a single line of the project is written:

- Real PostgreSQL **16.14** (PRD §3 requires PostgreSQL 16) — a real server process, real
  MVCC, real row locks. Not an in-memory fake, not PGlite, not a mock.
- `btree_gist`, `citext`, `pgcrypto` extensions present → PRD §7.3 (`CITEXT` email) and
  §8.4 / ADR-018 (GiST `EXCLUDE`) are both satisfiable.
- The **Phase 8 storage-layer backstop genuinely fires** (`23P01 no_sold_segment_overlap`),
  and disjoint legs `[0,3)` + `[3,7)` are both accepted — the capacity win of ADR-018.
- The **PRD §8.1 conditional allocation `UPDATE`** executes as specified.

Architecture note, recorded for load-test honesty: the shipped `postgres` binary is a Mach-O
*universal* binary and the running process reported the `x86_64-apple-darwin24.6.0` build
slice, i.e. it executes under Rosetta 2 on this M5. Correctness is unaffected — MVCC, row
locks and constraints behave identically. **Latency measured locally is therefore not
representative**, so no local timing may be published as a Phase 7 load-test result (PRD §15.3
requires real numbers; DEV-4 records where they must come from instead).

Therefore Phases 1–3, which are Postgres-only on the correctness path, can be **fully and
honestly verified on this machine today**, including the 1,000-against-100 concurrency gate.

## 5. Deviations register

Deviations are recorded here, carried into `DECISIONS.md` when they become real, and never
applied silently. No deviation below weakens a PRD invariant.

| ID | Deviation | Rationale | Invariant impact |
|---|---|---|---|
| DEV-1 | Local dev/test runtime is Node 24.18; PRD §3 locks Node 22 LTS | Node 22 is not installed and installing a second runtime is the user's call. Docker images will pin `node:22`, and `engines` will declare `>=22`. Nothing in the stack is Node-24-specific. | None |
| DEV-2 | Integration tests run against **embedded PostgreSQL 16.14** locally, and against **Testcontainers** where a Docker daemon exists (CI) | Docker is absent (§3). Both paths are a real PostgreSQL 16 server; the code under test cannot tell them apart. Implemented as one `withPostgres()` provider in `packages/testkit` that auto-selects. | **None** — the database is real in both paths. INV-1…INV-8 are proven against a real server either way. |
| DEV-3 | `PRD.md` / `DECISIONS.md` stay at repository root rather than moving to `docs/` per PRD §5 | They are the user-supplied source of truth; moving them breaks existing references for no gain. `docs/` will link to them. | None |
| DEV-4 | Phase 7 k6 numbers may **not** be produced on this machine while Postgres runs under Rosetta | PRD §15.3 and the user's brief both forbid invented or unrepresentative performance numbers. k6 must run against a container-based or native-arm64 stack. Until then the README carries no load figures — an empty section, never a fabricated one. | None (reporting integrity) |

## 6. RESOLVED — container runtime installed mid-Phase-1

The user installed Docker Desktop immediately after the Phase 0 gate. Verified:

```
docker: Docker version 29.8.0, build 88096ef
daemon: server=29.8.0 os=Docker Desktop arch=aarch64
compose: Docker Compose version v5.5.1
context: desktop-linux → unix:///Users/arpitpatel/.docker/run/docker.sock
docker pull postgres:16-alpine → docker.io/library/postgres:16-alpine   (OK)
```

Consequences — all in the project's favour:

- **R1 is closed.** Testcontainers (PRD §15.1) is the **primary** integration path; Redpanda,
  the Redis chaos kill and `docker compose up` are all achievable as specified.
- **DEV-2 is downgraded** from "Docker absent" to an ordinary offline fallback: Testcontainers
  when a daemon is reachable, embedded PostgreSQL 16 otherwise. Same migrations, same SQL.
- **DEV-4 is closed.** The daemon reports **aarch64**, so containers run natively with no Rosetta
  emulation. Phase 7 k6 numbers measured against the containerised stack are representative and
  may be published.

Two operational notes carried forward:

- The `docker` CLI is **not on the default shell PATH** (no `/usr/local/bin/docker` symlink); it
  lives at `/Applications/Docker.app/Contents/Resources/bin/docker`. Scripts must not assume `docker`
  resolves.
- There is **no `/var/run/docker.sock`**. The socket is at `~/.docker/run/docker.sock`, so
  Testcontainers needs `DOCKER_HOST` derived from the active docker context. `packages/testkit`
  resolves this automatically rather than relying on ambient configuration.
