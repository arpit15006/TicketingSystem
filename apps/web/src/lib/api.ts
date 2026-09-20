import type { ApiErrorBody, TokenPair } from "./api-types"
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  storeTokens,
} from "./tokens"

/**
 * The only way this app talks to the backend.
 *
 * PRD §13: the client talks **only to the gateway**. There is no second base URL
 * in this file on purpose — a component that wanted to reach a service directly
 * would have to add one, which is a reviewable act rather than an accident.
 */
export const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3000"

/** Every failed request becomes one of these, with the id an operator can grep. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string
  readonly details: unknown

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = "ApiError"
    this.status = status
    this.code = body.code
    this.requestId = body.requestId
    this.details = body.details
  }

  /** PRD §8.1 — the seats another buyer took, named exactly. */
  get unavailableSeatIds(): string[] {
    const details = this.details
    if (typeof details !== "object" || details === null) return []
    const ids = (details as { unavailableSeatIds?: unknown }).unavailableSeatIds
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  body?: unknown
  /** PRD §8.1 / §10.1 — makes a retried write safe. */
  idempotencyKey?: string
  /** PRD §12 — required on /reservations for waiting-room events. */
  admissionToken?: string
  signal?: AbortSignal
  /** Skip the Authorization header entirely (used by the auth routes themselves). */
  anonymous?: boolean
}

/* ─────────────────────────── refresh, single-flight ───────────────────────── */

/**
 * **The most important few lines in this file.**
 *
 * ADR-011 rotates the refresh token on every use and revokes the entire family if
 * a rotated token is presented again. That makes a concurrent refresh actively
 * dangerous: fire two requests with the same refresh token and the second one is,
 * by definition, a reuse — identity revokes the family and logs the user out of
 * every session. The reuse detector is doing its job; we would simply be the
 * attacker it was built to catch.
 *
 * A seat page can easily have four requests in flight when the access token
 * expires. So every refresh funnels through one promise, and the callers that
 * lose the race await the winner's result instead of starting their own.
 */
let refreshInFlight: Promise<string | null> | null = null

async function performRefresh(): Promise<string | null> {
  const refreshToken = getRefreshToken()
  if (refreshToken === null) {
    clearTokens()
    return null
  }

  const response = await fetch(`${GATEWAY_URL}/identity/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  })

  if (!response.ok) {
    // Includes REFRESH_TOKEN_REUSED, where the whole family has just been
    // revoked. Either way this session is over; the UI sends them to /login.
    clearTokens()
    return null
  }

  const pair = (await response.json()) as TokenPair
  storeTokens(pair)
  return pair.accessToken
}

function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight !== null) return refreshInFlight

  const attempt = performRefresh().finally(() => {
    refreshInFlight = null
  })
  refreshInFlight = attempt
  return attempt
}

/**
 * Refresh now, on purpose.
 *
 * Grants are read at token issue time (PRD §9.1). After creating an event the
 * caller has just been granted `organizer:event:<id>`, but the token in memory
 * predates it — so provisioning seats would 403 for up to ten minutes. Rotating
 * immediately picks the grant up. Same single-flight path as everything else.
 */
export function forceRefresh(): Promise<string | null> {
  return refreshAccessToken()
}

/* ──────────────────────────────── the client ─────────────────────────────── */

function buildHeaders(options: RequestOptions, token: string | null): Headers {
  const headers = new Headers()
  if (options.body !== undefined) headers.set("content-type", "application/json")
  if (token !== null && options.anonymous !== true) {
    headers.set("authorization", `Bearer ${token}`)
  }
  if (options.idempotencyKey !== undefined) {
    headers.set("idempotency-key", options.idempotencyKey)
  }
  if (options.admissionToken !== undefined) {
    headers.set("x-admission-token", options.admissionToken)
  }
  return headers
}

async function readError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody
  try {
    body = (await response.json()) as ApiErrorBody
  } catch {
    // A proxy error or a dropped connection — synthesise the shape so callers
    // never have to handle two different failure types.
    body = {
      code: "UNKNOWN",
      message: `Request failed with status ${response.status}`,
      requestId: response.headers.get("x-request-id") ?? "unknown",
    }
  }
  return new ApiError(response.status, body)
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (token: string | null): Promise<Response> =>
    fetch(`${GATEWAY_URL}${path}`, {
      method: options.method ?? "GET",
      headers: buildHeaders(options, token),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

  let token = getAccessToken()

  // After a reload the access token is gone but the refresh token is not. Mint
  // one up front rather than spending a guaranteed 401 to discover that.
  if (token === null && options.anonymous !== true && getRefreshToken() !== null) {
    token = await refreshAccessToken()
  }

  let response = await send(token)

  // The access token lives 10 minutes (PRD §9.1), so this is routine, not
  // exceptional. Exactly one retry: a second 401 means the refresh itself is
  // not being honoured, and retrying again would just spin.
  if (response.status === 401 && options.anonymous !== true) {
    const refreshed = await refreshAccessToken()
    if (refreshed !== null) response = await send(refreshed)
  }

  if (!response.ok) throw await readError(response)

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/* ─────────────────────────────────── SSE ─────────────────────────────────── */

export interface SseHandlers {
  onEvent: (event: string, data: unknown) => void
  onError?: (error: unknown) => void
}

/**
 * PRD §12 / ADR-016 — the queue position stream.
 *
 * Read with `fetch` rather than `EventSource`, which cannot send an
 * `Authorization` header — and the waiting room requires one. The alternative,
 * putting the token in the query string, would write a credential into every
 * access log between here and the service.
 *
 * Returns an abort function. The caller must call it on unmount, or the stream
 * outlives the page that was reading it.
 */
export function streamSse(path: string, handlers: SseHandlers): () => void {
  const controller = new AbortController()

  const run = async (): Promise<void> => {
    let token = getAccessToken()
    if (token === null && getRefreshToken() !== null) token = await refreshAccessToken()

    const headers = new Headers({ accept: "text/event-stream" })
    if (token !== null) headers.set("authorization", `Bearer ${token}`)

    const response = await fetch(`${GATEWAY_URL}${path}`, {
      headers,
      signal: controller.signal,
    })

    if (!response.ok) throw await readError(response)
    if (response.body === null) throw new Error("SSE response carried no body")

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""

    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += value

      // Frames are separated by a blank line; anything after the last one is a
      // partial frame and waits for the next chunk.
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""

      for (const frame of frames) {
        let name = "message"
        const dataLines: string[] = []
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim()
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
        }
        if (dataLines.length === 0) continue
        try {
          handlers.onEvent(name, JSON.parse(dataLines.join("\n")))
        } catch {
          handlers.onEvent(name, dataLines.join("\n"))
        }
      }
    }
  }

  run().catch((error: unknown) => {
    if (controller.signal.aborted) return
    handlers.onError?.(error)
  })

  return () => {
    controller.abort()
  }
}
