# Load test results

Every number here was produced by an actual run. Where a number does not mean what
it appears to mean, that is stated rather than quietly omitted.

## Run: 10,000 virtual users — 2026-09-20

| | |
|---|---|
| Command | `k6 run loadtest/onsale.js` with `K6_VUS=10000 K6_RAMP=30s K6_DURATION=60s` |
| k6 | v2.2.0, darwin/arm64, run **on the host** |
| Stack | full `docker compose` stack (10 containers) on the **same machine** |
| Machine | Apple M5, 10 cores, 16 GiB; Docker VM 7.7 GiB |
| Raw output | [`k6-10k-run.txt`](k6-10k-run.txt) |

```
vus_max ................ 10000
http_reqs .............. 181052   (2152/s)
oversell_suspected ..... 0
holds_won .............. 515
holds_lost (409) ....... 42
rate_limited_429 ....... 164131
connection_failures .... 16322
hold_latency ........... avg=3.33s med=1.6s p(95)=15s p(99)=15.58s max=1m0s
```

### What this run does and does not prove

**It proves the invariant holds under load.** 10,000 virtual users were sustained, 181,052
requests were served, and `oversell_total` read **0** afterwards — asserted by the script itself
in `teardown()`, reading `/metrics` from the reservation service rather than taking it on trust.

**It does not give meaningful latency numbers, and they are not published as such.** Two things
dominated the measurement, neither of which is the seat allocator:

1. **164,131 of 181,052 requests (91%) were `429`.** The gateway rate-limits **per IP** at 300
   requests/minute by default, and a load generator is a single IP. So this run mostly measured
   the rate limiter refusing traffic quickly, which is exactly what it is supposed to do and
   exactly not what the test was trying to measure. The p95 of 15s is queueing behind that, not
   seat allocation.
2. **16,322 requests never got an HTTP response at all.** macOS caps the listen backlog at
   `kern.ipc.somaxconn` (128, unraisable without root), so tens of thousands of simultaneous
   connection attempts overflow the kernel accept queue and are reset. The script counts these
   separately as `connection_failures` precisely so they can never be mistaken for the system
   failing to allocate a seat.

Running the load generator and a ten-container stack on one laptop is the binding constraint here,
not the application. Publishing `p95 = 15s` as "the system's latency" would be misleading, so it
is not published in the README.

### How to get a representative run

```bash
# 1. The per-IP limit has to be raised, or the load generator has to be distributed.
RATE_LIMIT_MAX=100000000 docker compose -f infra/docker-compose.yml --env-file .env up -d gateway

# 2. Reset inventory so there is real contention rather than an already-sold event.
docker compose -f infra/docker-compose.yml --env-file .env exec postgres \
  psql -U reservation -d reservation_db \
  -c "UPDATE seats SET status='available', hold_id=NULL, held_until=NULL, order_id=NULL; DELETE FROM holds;"

# 3. Run k6 from a DIFFERENT machine than the stack, and raise the file-descriptor limit.
ulimit -n 200000
GATEWAY_URL=http://<stack-host>:3000 EVENT_ID=<event> K6_VUS=10000 k6 run loadtest/onsale.js
```

Between runs, allow ~60 seconds for the host's ephemeral ports to leave `TIME_WAIT`. A run started
immediately after another will fail in `setup()` with no usable sockets — observed, not theorised.

## The measurement that is clean

The oversell proof runs in-process against a real PostgreSQL and is not affected by either
constraint above, because it uses a backlog-safe connection pool and no gateway:

```
requests fired      : 1000 (real parallel HTTP)
seats available     : 100
status counts       : {"201":100,"409":900}
client latency (ms) : p50=140.2 p95=200.9 p99=202.3 max=202.8
peak concurrent allocations in-flight: 128
oversell_total      : 0
```

That is the number worth quoting for allocation latency under contention, and it is the one the
README uses.
