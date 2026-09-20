# Technical Decisions

Why each piece of this system is what it is — and what I rejected.

Every entry follows the same shape: the decision, the alternatives considered, the reason, and the cost I accepted. The trade-off line matters most; a decision without a stated cost is usually a decision that wasn't really made.

---

## ADR-001 — PostgreSQL, not MongoDB (and therefore not MERN)

**Decision:** PostgreSQL as the system of record for every service.

**Rejected:** MongoDB / the MERN stack.

**Why:** The core requirement of this system is that a seat is never sold twice under concurrency. That needs an atomic conditional write with row-level locking and real transactional guarantees across multiple rows (a basket of seats succeeds or fails as a unit). Postgres gives me `UPDATE ... WHERE <condition> RETURNING` with MVCC row locks, multi-row transactions, and partial unique indexes as a final safety net at the storage layer.

MongoDB has single-document atomicity and, since 4.0, multi-document transactions — but using it here would mean building the core correctness guarantee on the feature the database is least optimized for, while giving up the schema constraints that catch bugs I haven't thought of. The document model also buys nothing: seats, orders and tickets are highly relational and uniformly shaped.

**Cost accepted:** Less flexible schema evolution; migrations are a real step. I consider that a benefit for this domain.

**Interview note:** MERN is a label for a monolith with one shared database. This project's entire thesis is database-per-service with transactional seat allocation. Naming the stack "Node.js microservices on Postgres + Kafka" is more accurate and signals the components were chosen rather than defaulted to.

---

## ADR-002 — Conditional SQL UPDATE, not a Redis distributed lock

**Decision:** Seat allocation is a single conditional `UPDATE` in Postgres.

```sql
UPDATE seats SET status='held', hold_id=$1, held_until=now()+interval '8 minutes'
WHERE seat_id = ANY($2)
  AND (status='available' OR (status='held' AND held_until < now()))
RETURNING seat_id;
```

**Rejected:** Redlock / Redis `SET NX PX` distributed locking, which is what most implementations of this problem reach for.

**Why:** A distributed lock introduces a gap between *holding the lock* and *acting on the data*. A process can acquire a lock, get paused — by a GC pause, a container CPU throttle, a network partition — have its lease expire, and then resume and write, still believing it holds the lock. Meanwhile another process has legitimately acquired the same lock. That's the classic fencing-token problem, and mitigating it properly requires the storage layer to reject stale writes, which means the storage layer needed to participate in the locking all along.

By making the lock *be* the data, that gap disappears entirely. Postgres takes a row lock for the duration of the `UPDATE` and the condition is evaluated against committed state. There is no lease to expire, no clock assumption, no split-brain. Zero rows returned means I lost the race; one row means the seat is mine. The check and the mutation are the same operation.

**Cost accepted:** All seat writes go to Postgres, so the database is the write bottleneck. At current scale this is nowhere near a limit; at 100× it would mean partitioning seats by event across shards — which is natural, since seats for different events never interact.

**Interview note:** This is the answer I'd most want to be asked about. The demonstration branch in the repo implements the Redlock version and shows it overselling under the same 1,000-request test.

---

## ADR-003 — Hold expiry as a query predicate, not a background job

**Decision:** `held_until < now()` is part of the `WHERE` clause on every allocation query. A hold is expired the instant the clock passes it, whether or not anything has "processed" the expiry.

**Rejected:** Redis key TTL with an expiry callback; a cron reaper that flips expired holds back to available.

**Why:** If freeing an expired hold requires a job to run, the job becomes a correctness dependency. Cron dies at 3am, Redis restarts and loses its keyspace notifications, the worker deploys with a bad config — and now seats are stranded and unsellable during the exact window they're most valuable. Making expiry a predicate means the correctness path has no moving parts to fail.

A janitor job still runs every 60 seconds to tidy stale rows, but it's cosmetic. **It is safe for it to never run.** That property is the point.

**Cost accepted:** Slightly more complex queries, and rows that look `held` in a naive `SELECT` when they're logically available. Anything reading availability must apply the same predicate, so it's centralized in one query module.

---

## ADR-004 — Database per service

**Decision:** Each service owns its schema and no service reads another's tables.

**Rejected:** One shared database with service-prefixed tables.

**Why:** A shared database is the thing that turns microservices into a distributed monolith. Once two services read the same table, you can't change that table's shape without coordinating a deploy, you can't reason about who wrote a row, and a slow query in one service degrades all of them. Enforced ownership is what makes the boundaries real rather than decorative.

**Cost accepted:** No cross-service joins, and data that used to be a join is now either an API call or a projection built from events. Catalog keeps its own availability counts, updated from `seat.sold` events — eventually consistent, and correct to do so, because a seatmap that's 2 seconds stale is fine while an allocation that's 2ms stale is not.

**Implementation note:** In Compose this runs as one Postgres instance with separate logical databases and separate credentials, rather than six containers. That's a resource compromise for local development, and the isolation boundary — no cross-database grants — is still enforced.

---

## ADR-005 — Kafka with the transactional outbox pattern

**Decision:** State changes and their events are written in the same Postgres transaction, to an `outbox` table. A relay worker polls unpublished rows and publishes them to Kafka.

**Rejected:** Publishing to the broker directly from application code after the DB commit.

**Why:** Writing to Postgres and then publishing to Kafka is a dual write across two systems with no shared transaction. If the process dies between them, the seat is sold and no notification ever fires — a silent, permanent inconsistency that no retry can detect because nothing recorded that the event was owed. The outbox collapses both writes into one atomic operation against a single system; the relay then makes publishing a retryable, resumable problem.

**Cost accepted:** At-least-once delivery, so every consumer must be idempotent (`processed_events` keyed by `event_id`). Also a small publish latency — the relay polls every 500ms — and a table that needs periodic pruning.

**Why Kafka over RabbitMQ:** Partitioning by aggregate ID gives per-entity ordering guarantees, and the replayable log means a new consumer can rebuild its state from history. Redpanda in dev keeps this to one container with no ZooKeeper.

---

## ADR-006 — Splitting catalog from reservation

**Decision:** Two services, even though both are "about seats."

**Why:** Read volume and consistency requirements diverge by orders of magnitude. Browsing a seatmap is a very high-volume read that tolerates staleness; allocating a seat is a comparatively rare write that tolerates none. Splitting them lets catalog be aggressively cached and scaled horizontally on cheap read replicas, while reservation stays small, write-focused, and strongly consistent.

**Cost accepted:** Catalog's availability numbers lag by up to a few seconds, so a user can click a seat that's already gone. That's handled at the point of allocation, where the conditional UPDATE returns a clean `409`. Showing a stale seatmap is acceptable; allocating from one is not.

---

## ADR-007 — Razorpay with manual capture

**Decision:** Create Razorpay Orders with `payment_capture: 0`. Authorize when the user pays, capture only after the seat transition to `sold` has succeeded.

**Rejected:** Auto-capture, with refunds when something goes wrong.

**Why:** Manual capture maps exactly onto the hold model. There's a window — however small — between payment succeeding and the seat being finalized, and in that window a hold can expire and the seat can be resold. With auto-capture, the money has already moved and I owe a refund that takes days to settle. With manual capture, I **void the authorization** instead: no money ever leaves the customer's account, resolution is immediate, and the customer sees a released hold rather than a pending refund.

**Cost accepted:** Authorizations expire (typically ~5 days) and must be captured or voided within that window, so an unresolved order can't sit indefinitely. Also more states to model.

**Implementation note (added during Phase 3):** Razorpay exposes no explicit *void*
endpoint for an authorized payment. The outcome this ADR describes is still exactly what
happens, by a slightly different mechanism: an authorization that is never captured expires on
its own (typically ~5 days), so declining to capture *is* the release — no money ever leaves the
customer's account, and there is no refund to settle. The compensation path therefore records
`releaseAction: 'authorization_released'` for the normal case, and falls back to a real refund
only when the payment was somehow already captured. Both branches are tested in
`expiry-boundary.spec.ts`.

**Related:** Signature verification requires the raw request body, because Razorpay HMACs the exact bytes it sent. Any JSON parse-then-reserialize changes key order and whitespace and breaks verification. Fastify needs a custom content-type parser preserving the raw `Buffer`. This is the most common implementation bug in Razorpay integrations.

---

## ADR-008 — Bounding, not eliminating, the payment-after-expiry race

**Decision:** Accept that the race exists. Shrink the window, detect the failure, and compensate automatically.

Three mechanisms:
1. Refuse to create a payment intent when less than 90 seconds of hold remain
2. Extend the hold at intent creation
3. On finalization failure, void or refund, mark the order `refunded_seat_lost`, notify the user with alternatives

**Why not eliminate it:** Eliminating it would require a transaction spanning my database and Razorpay's — a distributed transaction across an external system I don't control, whose network can fail at any point. No two-phase commit is available. The honest engineering answer is to make the window small, make the failure detectable, and make the recovery automatic and visible to the user.

**Cost accepted:** A small number of users will have a payment authorized and then released. They're told clearly and immediately, and offered alternative seats.

**Interview note:** This is the question a senior engineer asks about any hold-then-pay system. "It can't happen" is the wrong answer. "Here's the window, here's how I bounded it, here's the compensating transaction, here's the test that proves it fires" is the right one.

---

## ADR-009 — Idempotency keys on writes, event-ID dedupe on webhooks

**Decision:** Every mutating endpoint accepts an `Idempotency-Key`. The key, a hash of the request body, and the stored response live in a table with a unique constraint. Same key + same body replays the stored response; same key + different body returns `422`.

Separately, Razorpay's `x-razorpay-event-id` is inserted into `processed_webhooks` **before** processing; a duplicate-key violation means it's already handled.

**Why:** Mobile networks retry. Users double-tap. Payment providers deliver webhooks multiple times by design. Without this, a retried booking consumes two seats and a replayed webhook issues two tickets. The body hash matters because a client reusing a key for a *different* request is a bug that should surface loudly, not be silently served a stale response.

**Cost accepted:** An extra table write per request and a key-expiry policy (24h).

---

## ADR-010 — Authorization enforced per service, not at the gateway

**Decision:** The gateway verifies the JWT signature and forwards claims. Every service independently makes its own authorization decision.

**Rejected:** Centralizing authorization at the gateway and having services trust an `x-user-roles` header.

**Why:** A service that trusts an upstream header is one misconfigured ingress, one internal port exposure, or one pod-to-pod call away from full compromise. Defense in depth means the service that owns the resource is the one that decides who may touch it. It also keeps authorization logic next to the domain logic that defines it — the reservation service knows what "owns this hold" means; the gateway doesn't and shouldn't.

Permissions are resource-scoped rather than global: an organizer has `event:update` *for events they own*, not for all events. Flat global roles are the version that fails a security review.

**Cost accepted:** Some duplicated permission-checking code, mitigated by a shared `requirePermission()` plugin in `packages/http`.

---

## ADR-011 — Short-lived access tokens with refresh rotation and reuse detection

**Decision:** 10-minute RS256 access tokens, 14-day opaque refresh tokens rotated on every use, grouped by `family_id`. Presenting an already-rotated refresh token revokes the entire family.

**Why:** Stateless JWTs can't be revoked, which is the well-known tension. Rather than pretend otherwise, I bounded the exposure: a stolen access token is useful for at most 10 minutes, and a `jti` denylist in Redis handles urgent revocation within that window. Rotation with reuse detection means a stolen refresh token gets used at most once before the theft is detected and the whole family is killed.

**Cost accepted:** Up to 10 minutes of staleness on a revoked session unless the denylist is hit. That's an explicit, bounded trade for stateless verification at the edge.

---

## ADR-012 — Redis holds no correctness state

**Decision:** Redis is used for the waiting-room queue, seatmap read caching, rate limiting, and SSE pub/sub fan-out. It is never consulted to decide whether a seat is available.

**Why:** This is what lets me say: **if Redis is completely down, the waiting room fails open, seatmap reads fall back to Postgres with degraded latency, and seat allocation remains exactly correct.** There's a chaos test that kills the Redis container mid-sale and asserts zero oversells.

The contrast with a Redis-as-source-of-truth design is the whole argument. Redis is single-threaded per node, fast, and excellent at what it's used for here — none of which makes it the right place for money-adjacent correctness, given its default asynchronous replication can lose acknowledged writes on failover.

**Cost accepted:** Higher latency on seat operations than a Redis-backed design would show. Worth it; a fast wrong answer is worthless here.

---

## ADR-013 — Fastify, not Express or NestJS

**Decision:** Fastify 5.

**Why:** JSON Schema validation is built into the route definition, so malformed input is rejected before reaching a handler and the OpenAPI spec generates itself from the same schemas — one source of truth. Pino is the built-in logger, so structured logging and request-scoped child loggers come free. Throughput is roughly 2–3× Express, which matters because I publish load-test numbers.

**Rejected — Express:** Unopinionated to the point of every project inventing its own validation, error handling and logging conventions. No schema layer.

**Rejected — NestJS:** Good structure and DI, and it reads as "enterprise," but the decorator and module boilerplate would obscure the part of this codebase that matters — the raw conditional UPDATE. I wanted that to be the most visible code in the repo.

---

## ADR-014 — Raw SQL via `pg`, no ORM

**Decision:** No Prisma, no TypeORM, no Drizzle. `pg` with hand-written SQL and typed result mappers.

**Why:** The conditional UPDATE with `RETURNING`, the `FOR UPDATE SKIP LOCKED` general-admission query, and the partial unique index are the intellectual core of this project. An ORM either can't express them or hides them behind a `$queryRaw` escape hatch, which means I'd be paying the ORM's abstraction cost everywhere and bypassing it exactly where it mattered.

Beyond this project: knowing what SQL an ORM emits is the difference between fixing a production performance problem and guessing at it.

**Cost accepted:** More boilerplate for simple CRUD in catalog and identity, and no free migration generation (`node-pg-migrate` handles migrations explicitly).

---

## ADR-015 — Pino with request-ID propagation, not OpenTelemetry

**Decision:** Structured Pino logging with a `requestId` generated at the gateway and propagated through every HTTP call and Kafka message header.

**Rejected (deferred):** Full OpenTelemetry with Jaeger and Prometheus.

**Why:** Honest scoping. Proper distributed tracing is roughly a week of work for this many services, and the interview value of a Jaeger waterfall screenshot is largely matched by being able to `grep` one `requestId` and see a single booking travel gateway → reservation → orders → outbox → Kafka → notification, including a compensation case. Pino is already Fastify's logger, so the marginal cost was near zero.

**Cost accepted:** No latency breakdown per span, no service dependency graph. `oversell_total` is exposed as a Prometheus-format counter on `/metrics` so the invariant is machine-checkable, but there's no full metrics stack. Listed as future work in the README — and being able to say *why* something was deferred is a better signal than a half-wired collector.

---

## ADR-016 — SSE for queue position, not WebSockets

**Decision:** Server-Sent Events for waiting-room position updates.

**Why:** The traffic is strictly one-directional — the server pushes position, the client never sends anything. SSE is plain HTTP, so it passes through the existing gateway, auth middleware and load balancer with no special handling, and it reconnects automatically with `Last-Event-ID`. WebSockets would mean sticky sessions and a separate auth path for a feature that needs neither.

**Cost accepted:** Browser connection limits per domain on HTTP/1.1 (mitigated by HTTP/2), and no client→server channel if that's ever needed.

---

## ADR-017 — Next.js for the frontend

**Decision:** Next.js 15 App Router with shadcn/ui and Shadcn Studio blocks.

**Why:** Shadcn Studio's blocks and templates are built for Next.js, so using it with Vite would mean stripping `next/link` and `next/image` out of everything I copied. Next also gives server-side rendering for event pages, which matters for a public ticketing site where those pages should be indexable and fast on first paint.

The frontend is deliberately thin — a seatmap, a queue screen, checkout, and an organizer dashboard. Studio exists so that time goes into the chaos tests instead of hand-rolling a dropdown.

**Cost accepted:** A heavier frontend toolchain than this app needs. Acceptable given the reviewer audience is looking at the backend.

---

## ADR-018 — Segment allocation via Postgres range types and an exclusion constraint

**Decision:** For journey-based inventory, occupancy is stored as an `int4range` over stop sequence numbers in a `seat_occupancies` table, with a GiST `EXCLUDE` constraint preventing overlapping *sold* ranges for the same seat.

**Rejected:** Modelling each leg as its own seat row (one row per seat per leg). That multiplies inventory by leg count, turns a single booking into N writes that must all succeed together, and makes "is this seat free end to end" an aggregate query instead of an overlap test.

**Why:** The domain requirement is that a seat can serve multiple passengers on disjoint portions of a route. That is interval non-overlap, and Postgres expresses it natively — `EXCLUDE USING gist (seat_id WITH =, leg_range WITH &&)` makes double-selling a segment *impossible at the storage layer*, not merely unlikely. Application code can have a bug and the database will still refuse the write.

**The subtlety worth knowing:** the constraint covers only `state = 'sold'`. Index predicates in Postgres must be `IMMUTABLE`, and `now()` is not, so a partial constraint covering live holds (`held_until > now()`) cannot be expressed. Correctness is therefore two-layered: sold-vs-sold is a hard database guarantee; held conflicts are handled by the allocation query, serialized by a `SELECT ... FOR UPDATE` row lock on the parent `seats` row. That row lock is the per-seat mutex, and it's the same trick as ADR-002 — the lock and the data are the same object.

Expiry remains a predicate (ADR-003). The overlap check includes `held_until > now()`, so an expired hold on an overlapping leg blocks nothing and no reaper is needed.

**Cost accepted:** A second allocation path to maintain, behind a `SeatAllocator` interface. Availability queries become overlap tests rather than equality tests, which needs a GiST index to stay fast. Added deliberately as an optional final phase, after every other guarantee was proven.

**Interview note:** This is the IRCTC-shaped problem. A berth from Delhi to Chennai is not one unit of inventory — selling Delhi→Bhopal and Bhopal→Chennai to two passengers is correct and fully utilizes the berth. The test I'd point at is `segment-exclusion.spec.ts`, which bypasses the application layer entirely, inserts a conflicting sold row, and shows the transaction abort. Defence in depth demonstrated rather than claimed.

**What I still scoped out:** quotas (Tatkal, Ladies, Senior Citizen), waitlist and RAC promotion, berth-preference allocation, and tiered cancellation refunds. All real parts of rail ticketing, none of which add distributed-systems depth — they add domain rules. Saying which complexity I declined, and why, is part of the point.

---

## Known limitations

Stated plainly, because a README that claims no weaknesses isn't read as honest.

1. **Single Postgres instance in Compose.** Separate logical databases with separate credentials and no cross-grants, but one process. Real isolation means separate instances; this is a local-development resource compromise.
2. **Seat writes are single-node.** Horizontal scaling of allocation would require sharding seats by `event_id`, which is natural but unimplemented.
3. **No distributed tracing.** See ADR-015.
4. **Outbox relay polls.** 500ms adds latency; logical replication (CDC) would be lower-latency and is the natural next step.
5. **Authorization staleness up to 10 minutes** unless the `jti` denylist is consulted. See ADR-011.
6. **Waiting-room fairness is approximate.** Position is by join timestamp in a Redis sorted set; a Redis failover could disturb ordering. Since it fails open and holds no correctness state, the worst case is an unfair queue, not an oversell.
7. **No idempotent retries on outbound Razorpay calls**, so a network timeout during capture requires reconciliation against Razorpay's API. A reconciliation job is future work.

---

## What I would change at 100× scale

- Shard `seats` by `event_id` — different events never interact, so this partitions cleanly
- Replace the polling outbox relay with logical-replication CDC (Debezium) to cut publish latency
- Move seatmap reads onto read replicas with a CDN in front of the static seatmap geometry
- Add OpenTelemetry properly, with the `oversell_total` invariant as a paging alert
- Pre-materialize availability counts per tier rather than aggregating on read
- Move the waiting room to a dedicated cluster; it's the component most exposed to thundering herds and the one whose failure is least harmful

---

## Questions I expect, and the short answers

**"Why not just use a lock?"** → ADR-002. The lock and the data being separate is the bug. Fencing-token problem. The repo has a branch that demonstrates the Redlock version overselling under the same test.

**"What happens if payment succeeds but the seat is gone?"** → ADR-008. Bounded window, automatic void, `refunded_seat_lost`, user notified with alternatives. There's a test named `expiry-boundary.spec.ts` that proves it fires.

**"How do you know it doesn't oversell?"** → 1,000 concurrent requests against 100 seats, exactly 100 succeed, runs in CI on every push. Output is at the top of the README.

**"Why Kafka and not just HTTP calls between services?"** → Synchronous chains couple availability — if notification is down, bookings fail. Events decouple that, and the outbox makes the handoff atomic with the state change.

**"Isn't six services overkill?"** → Probably, for this traffic. The boundaries were chosen to be defensible rather than numerous: catalog/reservation splits on consistency requirements (ADR-006), orders splits on owning an external integration and a state machine. I'd merge notification into orders in a real v1.

**"Why MERN wasn't used"** → ADR-001. Seat allocation needs transactional guarantees; Mongo would have undermined the project's central correctness argument.
