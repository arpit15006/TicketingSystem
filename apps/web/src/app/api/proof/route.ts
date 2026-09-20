import { NextResponse } from "next/server"

/**
 * The concurrency demo's load generator.
 *
 * It lives on the Next server rather than in the browser for one reason: a
 * browser on HTTP/1.1 opens at most six connections to an origin, so a "storm"
 * fired from the page would reach the allocator six requests at a time and prove
 * nothing about contention. Node's fetch has no such cap. This is the same shape
 * as the k6 script and the test harness — a load generator that talks only to
 * the gateway, with the caller's own token — not a backdoor into a service.
 *
 * Everything reported is measured, nothing is assumed: each request's status,
 * each winning seat id (checked for duplicates), the availability count before
 * and after, and the reservation service's own counters afterwards.
 */

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3000"
// The edge rate limit is 300/min per IP; this server is one IP.
const MAX_REQUESTS = 300
const MAX_SEATS = 100
// macOS's default listen backlog is 128; more simultaneous SYNs than that get
// reset by the kernel and would show up as transport failures, not as truth
// about the allocator. The test harness bounds itself the same way.
const MAX_IN_FLIGHT = 128

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface Body {
  eventId?: unknown
  requests?: unknown
  seats?: unknown
}

async function pool<T>(size: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= tasks.length) return
      results[i] = await tasks[i]!()
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker))
  return results
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!

export async function POST(request: Request): Promise<Response> {
  const authorization = request.headers.get("authorization")
  if (authorization === null) return NextResponse.json({ error: "Sign in first" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as Body
  const eventId = typeof body.eventId === "string" ? body.eventId : ""
  const requests = Math.max(1, Math.min(MAX_REQUESTS, Number(body.requests) || 200))
  const seats = Math.max(1, Math.min(MAX_SEATS, requests, Number(body.seats) || 20))
  if (!/^[0-9a-f-]{36}$/.test(eventId)) return NextResponse.json({ error: "eventId required" }, { status: 400 })

  const headers = { authorization, "content-type": "application/json" }

  class RateLimited extends Error {
    constructor(readonly retryAfterSeconds: number | null) {
      super("rate limited")
    }
  }

  const availability = async (): Promise<number> => {
    const r = await fetch(`${GATEWAY}/availability?eventId=${eventId}&limit=5000`)
    if (r.status === 429) throw new RateLimited(Number(r.headers.get("retry-after")) || null)
    if (!r.ok) throw new Error(`availability failed: ${r.status}`)
    return ((await r.json()) as { available: number }).available
  }

  /*
   * The gateway limits per IP, and behind the compose bridge the browser and this
   * server are one IP. A 429 before the storm even starts is not a finding about
   * the allocator — say what it is and how long to wait.
   */
  const rateLimitedResponse = (e: RateLimited): Response =>
    NextResponse.json(
      {
        error:
          `The gateway's per-IP rate limit is exhausted (storefront polling and this storm share one address). ` +
          (e.retryAfterSeconds !== null ? `Try again in ${e.retryAfterSeconds}s, ` : "Wait a minute, ") +
          "or raise RATE_LIMIT_MAX for local runs.",
        rateLimited: true,
      },
      { status: 429 }
    )

  /* ── the seats under contention ────────────────────────────────────── */
  const free = await fetch(`${GATEWAY}/availability?eventId=${eventId}&limit=${seats}`)
  if (free.status === 429) return rateLimitedResponse(new RateLimited(Number(free.headers.get("retry-after")) || null))
  if (!free.ok) return NextResponse.json({ error: `availability failed: ${free.status}` }, { status: 502 })
  const targets = ((await free.json()) as { seats: { seat_id: string }[] }).seats.map((s) => s.seat_id)
  if (targets.length === 0) return NextResponse.json({ error: "No free seats on this event" }, { status: 409 })

  let availabilityBefore: number
  try {
    availabilityBefore = await availability()
  } catch (e) {
    if (e instanceof RateLimited) return rateLimitedResponse(e)
    throw e
  }

  /* ── the storm ─────────────────────────────────────────────────────── */
  type Outcome = { status: number; ms: number; holdId?: string; seatId?: string; requestId?: string }
  const startedAt = performance.now()
  const outcomes = await pool<Outcome>(
    MAX_IN_FLIGHT,
    Array.from({ length: requests }, (_, i) => async () => {
      // Every request wants one seat; ~requests/seats of them want the same one.
      const seatId = targets[i % targets.length]!
      const t0 = performance.now()
      try {
        const r = await fetch(`${GATEWAY}/reservations`, {
          method: "POST",
          headers: { ...headers, "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ eventId, seatIds: [seatId] }),
        })
        const ms = performance.now() - t0
        const requestId = r.headers.get("x-request-id") ?? undefined
        if (r.status === 201) {
          const hold = (await r.json()) as { holdId: string; seatIds: string[] }
          const seat = hold.seatIds[0]
          return { status: 201, ms, holdId: hold.holdId, ...(seat === undefined ? {} : { seatId: seat }), ...(requestId ? { requestId } : {}) }
        }
        await r.text()
        return { status: r.status, ms, ...(requestId ? { requestId } : {}) }
      } catch {
        return { status: 0, ms: performance.now() - t0 }
      }
    })
  )
  const wallMs = Math.round(performance.now() - startedAt)

  /* ── what happened, counted ────────────────────────────────────────── */
  const won = outcomes.filter((o) => o.status === 201)
  const lost = outcomes.filter((o) => o.status === 409).length
  const rateLimited = outcomes.filter((o) => o.status === 429).length
  const other = outcomes.length - won.length - lost - rateLimited
  const winningSeats = won.map((o) => o.seatId).filter((s): s is string => s !== undefined)
  const distinctWinningSeats = new Set(winningSeats).size
  const duplicateWins = winningSeats.length - distinctWinningSeats

  const availabilityAfter = await availability().catch((e: unknown) => (e instanceof RateLimited ? -1 : Promise.reject(e)))

  const latencies = outcomes.filter((o) => o.status !== 0).map((o) => o.ms).sort((a, b) => a - b)

  /* ── release every hold this run took, so the demo cleans up ───────── */
  const releases = await pool(
    MAX_IN_FLIGHT,
    won.map((o) => async () => {
      // No content-type on a bodiless DELETE: Fastify rejects an empty JSON body
      // with 400, and the holds would sit until expiry.
      const r = await fetch(`${GATEWAY}/reservations/${o.holdId}`, { method: "DELETE", headers: { authorization } })
      return r.ok
    })
  )
  const availabilityRestored = await availability().catch((e: unknown) => (e instanceof RateLimited ? -1 : Promise.reject(e)))

  /* ── the service's own word ────────────────────────────────────────── */
  let metrics: Record<string, number> | null = null
  try {
    const m = await fetch(`${GATEWAY}/metrics`)
    if (m.ok) {
      metrics = {}
      for (const line of (await m.text()).split("\n")) {
        const match = /^([a-z_]+) (\d+)$/.exec(line)
        if (match) metrics[match[1]!] = Number(match[2])
      }
    }
  } catch {
    metrics = null
  }

  return NextResponse.json({
    eventId,
    requests,
    seats: targets.length,
    outcomes: { won: won.length, lost, rateLimited, other },
    distinctWinningSeats,
    duplicateWins,
    availabilityBefore,
    availabilityAfter,
    expectedAfter: availabilityBefore - won.length,
    availabilityRestored,
    released: releases.filter(Boolean).length,
    latencyMs: {
      p50: Math.round(percentile(latencies, 50)),
      p95: Math.round(percentile(latencies, 95)),
      p99: Math.round(percentile(latencies, 99)),
      max: Math.round(latencies[latencies.length - 1] ?? 0),
    },
    wallMs,
    inFlightCap: MAX_IN_FLIGHT,
    metrics,
    sampleRequestIds: outcomes.map((o) => o.requestId).filter((r): r is string => r !== undefined).slice(0, 3),
  })
}
