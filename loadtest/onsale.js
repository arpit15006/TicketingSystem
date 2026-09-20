/**
 * PRD §15.3 — the on-sale moment.
 *
 * Virtual users arrive, read availability, and try to hold a seat. Most of them
 * lose, which is the point: at an on-sale the interesting number is not how fast
 * the happy path is, it is how fast the system says NO under contention while
 * still never selling a seat twice.
 *
 * A 409 is therefore a SUCCESS here, not an error. Counting it as a failure would
 * make the results meaningless — the test would "fail" precisely when the system
 * is behaving correctly.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const GATEWAY = __ENV.GATEWAY_URL || 'http://localhost:3000';
const EVENT_ID = __ENV.EVENT_ID;
const VUS = Number(__ENV.K6_VUS || 10000);
const DURATION = __ENV.K6_DURATION || '60s';
const RAMP = __ENV.K6_RAMP || '30s';

// Held separately so the summary can tell "seat taken" apart from "broken".
const holdsWon = new Counter('holds_won');
const holdsLost = new Counter('holds_lost');
const oversellSuspected = new Counter('oversell_suspected');
const holdLatency = new Trend('hold_latency', true);
const errorRate = new Rate('unexpected_errors');

// Broken down by cause, because "10% errors" is not actionable and the usual
// culprit on a single-machine run is the OS, not the service under test.
const rateLimited = new Counter('rate_limited_429');
const connectionFailures = new Counter('connection_failures');
const serverErrors = new Counter('server_errors_5xx');
const otherErrors = new Counter('other_unexpected');

export const options = {
  scenarios: {
    onsale: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // The invariant, expressed as a threshold: any oversell fails the run.
    oversell_suspected: ['count==0'],
    unexpected_errors: ['rate<0.05'],
  },
  // Tokens are minted in setup(); VUs must not pay for TLS or auth setup.
  discardResponseBodies: false,
};

export function setup() {
  if (!EVENT_ID) throw new Error('EVENT_ID is required; run `pnpm seed` and pass the event id');

  // A pool of real users, created once. Minting 10,000 argon2 registrations would
  // measure argon2, not seat allocation.
  const tokens = [];
  const poolSize = Number(__ENV.K6_USER_POOL || 40);

  for (let i = 0; i < poolSize; i += 1) {
    const email = `k6.${Date.now()}.${i}.${randomIntBetween(1, 1e9)}@loadtest.test`;
    const res = http.post(
      `${GATEWAY}/identity/auth/register`,
      JSON.stringify({ email, password: 'correct horse battery staple', fullName: 'k6 user' }),
      { headers: { 'content-type': 'application/json' } },
    );
    if (res.status === 201) tokens.push(res.json('accessToken'));
  }

  if (tokens.length === 0) throw new Error('could not register any load-test users');

  const availability = http.get(`${GATEWAY}/availability?eventId=${EVENT_ID}&limit=5000`);
  const seats = availability.json('seats').map((s) => s.seat_id);
  if (seats.length === 0) throw new Error('no seats available; re-run `pnpm seed`');

  return { tokens, seats };
}

export default function (data) {
  const token = data.tokens[randomIntBetween(0, data.tokens.length - 1)];
  const seatId = data.seats[randomIntBetween(0, data.seats.length - 1)];

  const res = http.post(
    `${GATEWAY}/reservations`,
    JSON.stringify({ eventId: EVENT_ID, seatIds: [seatId] }),
    {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      tags: { name: 'POST /reservations' },
    },
  );

  holdLatency.add(res.timings.duration);

  if (res.status === 201) {
    holdsWon.add(1);
  } else if (res.status === 409) {
    // Correct behaviour under contention: someone else got there first.
    holdsLost.add(1);
  } else if (res.status === 429) {
    // Rate limited at the edge, which is the gateway doing its job.
    rateLimited.add(1);
  } else if (res.status === 0) {
    /*
     * No HTTP response at all: the connection was refused, reset or timed out.
     *
     * On a single-machine run this is almost always the OS rather than the
     * service. macOS caps the listen backlog at kern.ipc.somaxconn (128, and
     * unraisable without root), so tens of thousands of simultaneous connection
     * attempts overflow the kernel accept queue and get RST. Counted separately
     * so it can never be mistaken for the system failing to allocate a seat.
     */
    connectionFailures.add(1);
    errorRate.add(1);
  } else if (res.status >= 500) {
    serverErrors.add(1);
    errorRate.add(1);
  } else {
    otherErrors.add(1);
    errorRate.add(1);
  }

  check(res, {
    'seat resolved to won or lost, never ambiguous': (r) => [201, 409, 429].includes(r.status),
  });
}

/**
 * After the run, read `oversell_total` straight from the reservation service.
 * The load test asserts the invariant rather than assuming it survived.
 */
export function teardown() {
  const metrics = http.get(`${__ENV.RESERVATION_URL || 'http://reservation:3003'}/metrics`);
  const match = /oversell_total (\d+)/.exec(metrics.body || '');
  const oversells = match ? Number(match[1]) : -1;
  if (oversells !== 0) oversellSuspected.add(1);
  console.log(`oversell_total after load: ${oversells}`);
}
