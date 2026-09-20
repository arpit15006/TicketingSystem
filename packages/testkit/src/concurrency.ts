import { Agent, request } from 'undici';

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ConcurrentResult {
  index: number;
  status: number;
  body: unknown;
  durationMs: number;
  /** TCP connections refused by the kernel accept queue before this request was sent. */
  connectRetries: number;
}

export interface FireOptions {
  baseUrl: string;
  count: number;
  build: (index: number) => RequestSpec;
  /** Simultaneous TCP connections. Defaults to a backlog-safe 128. */
  connections?: number;
  /** Bounded retries for connections the kernel never accepted. */
  maxConnectRetries?: number;
}

/**
 * True only when the failure happened while *establishing* the connection, so the
 * request was provably never transmitted.
 *
 * This distinction is load-bearing. macOS caps the listen backlog at
 * `kern.ipc.somaxconn` (128 by default, and unraisable without root), so firing
 * 1,000 simultaneous SYNs overflows the kernel accept queue and the OS answers
 * some of them with RST. That is the operating system, not the service, and not
 * the allocation logic under test.
 *
 * Retrying is safe precisely because nothing was sent: no hold can have been
 * created, so a retry cannot double-book. An ECONNRESET *mid-request* is NOT
 * retried — that one is ambiguous, and quietly retrying an ambiguous write is how
 * a concurrency test starts lying about its own results.
 */
function isUnsentConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  // undici prefixes genuine connect-phase failures with "connect ".
  return error.message.startsWith('connect ') && (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * PRD §15.2 — the concurrency harness.
 *
 * This fires genuinely parallel HTTP requests at a running server. It does NOT
 * simulate concurrency inside one transaction, and that distinction is the whole
 * value of the test: simulated concurrency proves the code path, real concurrency
 * proves the *database* arbitrates correctly when a thousand transactions collide.
 *
 * Two details matter for the collision to be real:
 *
 *  - the connection pool is sized to the request count, so requests are not
 *    silently queued two-at-a-time onto a small pool and serialized before they
 *    ever reach Postgres;
 *  - every request is constructed first and released together behind a barrier, so
 *    the burst is as tight as the machine can make it rather than a slow ramp.
 */
export async function fireConcurrentRequests(options: FireOptions): Promise<ConcurrentResult[]> {
  const { baseUrl, count, build } = options;

  // Every request is released at once, but they share a bounded connection pool.
  //
  // macOS caps the listen backlog at kern.ipc.somaxconn (128, unraisable without
  // root), so opening a socket per request overflows the kernel accept queue: the
  // OS answers with RST, and undici can then throw `setTypeOfService EINVAL` while
  // writing to a socket the kernel already tore down — an unhandled error that
  // hangs the run. Staying at the backlog limit removes the artifact entirely.
  //
  // This does not weaken the proof. Concurrency is asserted where it actually
  // matters — `seat_hold_inflight_peak`, measured inside the service — not by
  // counting client sockets, which proves nothing about transaction overlap.
  const agent = new Agent({
    connections: options.connections ?? Math.min(count, 128),
    pipelining: 1,
    connectTimeout: 30_000,
    headersTimeout: 120_000,
    bodyTimeout: 120_000,
  });

  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    const inFlight = Array.from({ length: count }, async (_unused, index): Promise<ConcurrentResult> => {
      const spec = build(index);
      await barrier;

      const started = performance.now();
      const maxRetries = options.maxConnectRetries ?? 60;
      let connectRetries = 0;
      let response;

      for (;;) {
        try {
          response = await request(`${baseUrl}${spec.path}`, {
            method: spec.method,
            dispatcher: agent,
            headers: {
              'content-type': 'application/json',
              ...(spec.headers ?? {}),
            },
            ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
          });
          break;
        } catch (error) {
          if (connectRetries >= maxRetries || !isUnsentConnectionFailure(error)) throw error;
          connectRetries += 1;
          // Backoff must widen as pressure persists. Too short and every retry
          // re-collides with the same full accept queue; the jitter is what
          // de-synchronizes a thousand clients that all failed at the same instant.
          await sleep(Math.random() * Math.min(20 * connectRetries, 400));
        }
      }

      const text = await response.body.text();
      let parsed: unknown = text;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        // Leave the raw text; a non-JSON body is itself a useful failure signal.
      }

      return { index, status: response.statusCode, body: parsed, durationMs: performance.now() - started, connectRetries };
    });

    release();
    return await Promise.all(inFlight);
  } finally {
    await agent.close();
  }
}

/** Total kernel-refused connection attempts across a run, reported for transparency. */
export function totalConnectRetries(results: readonly ConcurrentResult[]): number {
  return results.reduce((sum, r) => sum + r.connectRetries, 0);
}

/** Count results by HTTP status — the shape every proof assertion reads. */
export function countByStatus(results: readonly ConcurrentResult[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  return counts;
}

export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function latency(results: readonly ConcurrentResult[]): LatencySummary {
  const sorted = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? 0 };
}
