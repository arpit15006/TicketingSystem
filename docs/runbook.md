# Runbook

Operational procedures for the ticketing platform. Written for whoever is holding the
pager, not for whoever wrote the code.

---

## 1. `oversell_total` is non-zero

**This is the one alert that must never fire.** It means a seat may have been sold
twice, which is the single failure this system is built to prevent.

### Severity

Page immediately. Every minute the on-sale continues is another potential duplicate sale.

### What the metric actually means

`oversell_total` is not a code-level counter that someone remembered to increment. It is
a **query** run against `reservation_db` every time `/metrics` is scraped:

```sql
SELECT count(*) FROM (
  SELECT seat_id FROM seats WHERE status = 'sold'
  GROUP BY seat_id HAVING count(DISTINCT order_id) > 1
) AS d
```

In whole-seat mode the schema makes this structurally impossible — one seat is one row
carrying one `order_id`. **So a non-zero value means something is wrong at a level below
the application**: a bad migration, a manual `UPDATE` in production, restored-from-backup
data, or (in segmented mode) a hole in the allocation query.

### Immediate actions

1. **Stop the bleeding.** Take the event off sale so no further allocations happen:

   ```bash
   curl -X PATCH "$GATEWAY/catalog/events/$EVENT_ID" \
     -H "authorization: Bearer $ADMIN_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"onsaleAt": null}'
   ```

   If catalog is unreachable, scale the reservation service to zero. Refusing to sell is
   always better than selling the same seat twice.

2. **Identify the affected seats** — do this before anything mutates state:

   ```sql
   SELECT seat_id, event_id, order_id, version, updated_at
   FROM seats WHERE status = 'sold'
   GROUP BY seat_id, event_id, order_id, version, updated_at
   HAVING count(DISTINCT order_id) > 1;
   ```

3. **Find the duplicate tickets.** `tickets.seat_id` is `UNIQUE`, so a genuine double-sale
   normally fails at ticket issue. Check whether tickets were actually issued for both
   orders, because that determines whether real customers are affected:

   ```sql
   SELECT t.seat_id, t.order_id, t.ticket_id, o.status, o.razorpay_payment_id
   FROM tickets t JOIN orders o USING (order_id)
   WHERE t.seat_id IN (<affected seat ids>);
   ```

4. **Decide who keeps the seat.** Earliest `orders.created_at` wins — it is the least
   arbitrary rule and the easiest to defend to a customer.

5. **Compensate the loser through the normal path**, never by hand: mark the order
   `compensating` and let the compensation logic void or refund it, so the customer gets
   the same notification any other compensated booking produces.

### Root cause checklist

- Did a migration run that changed `seats`? Check `pgmigrations`.
- Did anyone run a manual `UPDATE` against `reservation_db`? Check Postgres logs.
- Is the service running the expected build? Check the image digest.
- **In segmented mode**, look for `segment.exclusion.violated` in the logs. That event
  firing means the `EXCLUDE` constraint caught what the query layer should have
  prevented — the database saved you, and there is a real bug in the allocation query.

### What NOT to do

- Do not "fix" it by setting the counter to zero.
- Do not delete a `seats` row. Downstream `tickets` and `orders` reference it.
- Do not disable the partial unique index or the `EXCLUDE` constraint to make an insert
  succeed. They are the last line of defence.

---

## 2. Seats appear stuck in `held` and are not selling

**Usually not an incident.** Expiry is a query predicate, not a job (ADR-003): a row can
read `held` in a naive `SELECT` while being fully available to buyers, because every
allocation query also checks `held_until < now()`.

Confirm with the predicate rather than the column:

```sql
-- Genuinely unavailable right now:
SELECT count(*) FROM seats
WHERE event_id = $1 AND NOT (status = 'available' OR (status = 'held' AND held_until < now()));

-- Untidied but sellable — cosmetic only:
SELECT count(*) FROM seats
WHERE event_id = $1 AND status = 'held' AND held_until < now();
```

If the second number is large, the janitor is not running. **That is not urgent** — it
tidies rows for clean reads and analytics, and it is safe for it to never run. Restart the
reservation service when convenient.

If the *first* number is unexpectedly large, holds are genuinely live. Look for a client
holding seats and never completing checkout, and consider shortening
`HOLD_DURATION_SECONDS` for the event.

---

## 3. Payments are authorized but orders are not confirming

Symptom: `orders.status = 'payment_authorized'` accumulating.

1. **Is reservation reachable from orders?** Finalization is an HTTP call.

   ```bash
   docker compose exec orders node -e "fetch('http://reservation:3003/readyz').then(r=>console.log(r.status))"
   ```

2. **Is the internal service token correct?** Finalize is service-to-service only; a
   mismatch shows up as `401` in reservation's logs on `/reservations/*/finalize`.

3. **Are the holds expiring before payment settles?** If so the orders are being
   compensated, not stuck — check for `payment.after_expiry.compensated` and consider
   raising `MIN_HOLD_SECONDS_FOR_ORDER`.

Replaying the Razorpay webhook is safe at any point: settlement is idempotent, so a
redelivery converges rather than double-issuing.

---

## 4. Redis is down

**Expected behaviour: nothing breaks.** Redis holds no correctness state (ADR-012).

- Waiting room: fails open, admits everyone immediately, responses carry `degraded: true`
- Seatmap: falls back to Postgres, `x-cache: miss`, higher latency
- Rate limiting: skipped rather than failing requests
- `jti` denylist: fails open, so a logout may take up to the access-token TTL (10 minutes)
  to be enforced

**Seat allocation is unaffected.** If you are seeing oversells, Redis is not the cause —
go to §1.

Verify with `chaos-redis.spec.ts`, which asserts exactly this.

---

## 5. Kafka / Redpanda is down

**Expected behaviour: events queue, nothing is lost.**

Unpublished events accumulate in each producer's `outbox` table with `published_at IS NULL`.
The relay retries every 500 ms and fails harmlessly until the broker returns.

```sql
SELECT count(*) FROM outbox WHERE published_at IS NULL;   -- run per service database
```

A growing number during an outage is correct. If it is still growing *after* the broker
recovers, check the relay logs for `outbox relay cycle failed`.

Bookings continue throughout: the correctness path never touches Kafka.

---

## 6. Identity restarted and everything is returning 401

Almost certainly **`JWT_PRIVATE_KEY` is not configured**, so identity generated a fresh
keypair at boot, invalidating every live token and every cached JWKS.

```bash
pnpm keys:generate >> .env
docker compose -f infra/docker-compose.yml --env-file .env up -d identity
```

Production refuses to start without a configured keypair for exactly this reason. Verifiers
refetch the JWKS within ~5 seconds of seeing an unknown `kid`, so a genuine key rotation
recovers on its own.

---

## 7. Routine operations

### Bring the stack up

```bash
pnpm keys:generate >> .env          # once, so tokens survive restarts
docker compose -f infra/docker-compose.yml --env-file .env up -d --wait
pnpm seed                            # demo organizer, venue, 5,000-seat on-sale event
```

### Trace one booking across every service

```bash
REQ=$(uuidgen)
curl -X POST http://localhost:3000/reservations -H "x-request-id: $REQ" ...
docker compose -f infra/docker-compose.yml logs --no-color | grep "$REQ"
```

### Check the invariant by hand

```bash
curl -s http://localhost:3003/metrics | grep oversell_total   # must be 0
```

### Prune published outbox rows

Not automated. Safe to delete rows that have been published and consumed:

```sql
DELETE FROM outbox WHERE published_at < now() - interval '7 days';
```
