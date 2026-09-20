import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

/**
 * ADR-011 rotates the refresh token on every use and revokes the whole family if
 * a rotated token is presented twice. That makes the client's refresh logic a
 * correctness concern rather than a convenience: get it wrong and the app logs
 * its own user out of every session, and the reuse detector is right to do it.
 *
 * The module holds process-wide state (the in-flight promise, the in-memory
 * access token), so each test re-imports it fresh.
 */

interface FakeStorage {
  store: Map<string, string>
}

function installBrowserGlobals(refreshToken: string | null): FakeStorage {
  const store = new Map<string, string>()
  if (refreshToken !== null) store.set("ticketing.refreshToken", refreshToken)

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    },
  })

  return { store }
}

async function loadClient() {
  vi.resetModules()
  const api = await import("../../src/lib/api")
  const tokens = await import("../../src/lib/tokens")
  return { ...api, ...tokens }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window")
})

describe("api client refresh", () => {
  /**
   * The test that matters. Five requests are in flight when the access token
   * expires — routine on a seat page. If each one refreshed independently, four
   * of them would present an already-rotated token, identity would revoke the
   * family, and the buyer would be thrown out mid-checkout.
   */
  it("refreshes exactly once when several requests hit 401 together", async () => {
    installBrowserGlobals("refresh-token-1")
    const client = await loadClient()

    let refreshCalls = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)

      if (url.endsWith("/identity/auth/refresh")) {
        refreshCalls += 1
        // A real rotation hands back a different refresh token every time.
        return json(200, {
          accessToken: `access-${refreshCalls}`,
          refreshToken: `refresh-token-${refreshCalls + 1}`,
          expiresIn: 600,
        })
      }

      const auth = new Headers(init?.headers).get("authorization")
      if (auth === null || auth === "Bearer stale") {
        return json(401, { code: "UNAUTHORIZED", message: "expired", requestId: "req-401" })
      }
      return json(200, { ok: true, sentWith: auth })
    })
    vi.stubGlobal("fetch", fetchMock)

    // Seed a stale access token so the first attempt genuinely 401s.
    client.storeTokens({ accessToken: "stale", refreshToken: "refresh-token-1" })

    const results = await Promise.all([
      client.api<{ sentWith: string }>("/catalog/events"),
      client.api<{ sentWith: string }>("/availability?eventId=a"),
      client.api<{ sentWith: string }>("/orders/1"),
      client.api<{ sentWith: string }>("/identity/me"),
      client.api<{ sentWith: string }>("/reservations/2"),
    ])

    // THE assertion: one rotation, not five.
    expect(refreshCalls).toBe(1)
    // And every caller got the refreshed token, not a stale one.
    expect(results.every((r) => r.sentWith === "Bearer access-1")).toBe(true)
    // The rotated refresh token was persisted for next time.
    expect(client.getRefreshToken()).toBe("refresh-token-2")
  })

  it("mints a token up front after a reload instead of spending a guaranteed 401", async () => {
    installBrowserGlobals("refresh-token-1")
    const client = await loadClient()

    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        seen.push(url)
        if (url.endsWith("/identity/auth/refresh")) {
          return json(200, { accessToken: "fresh", refreshToken: "r2", expiresIn: 600 })
        }
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh")
        return json(200, { ok: true })
      })
    )

    // No access token in memory — exactly the state after a page reload.
    await client.api("/identity/me")

    expect(seen[0]).toContain("/identity/auth/refresh")
    expect(seen).toHaveLength(2)
  })

  it("clears the session when the refresh token has been revoked", async () => {
    installBrowserGlobals("rotated-already")
    const client = await loadClient()

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/identity/auth/refresh")) {
          return json(401, {
            code: "REFRESH_TOKEN_REUSED",
            message: "Refresh token reuse detected; all sessions revoked",
            requestId: "req-reuse",
          })
        }
        return json(401, { code: "UNAUTHORIZED", message: "expired", requestId: "req-401" })
      })
    )

    await expect(client.api("/identity/me")).rejects.toMatchObject({ status: 401 })

    // Nothing left to retry with, so the UI can send them to /login.
    expect(client.getRefreshToken()).toBeNull()
    expect(client.getAccessToken()).toBeNull()
    expect(client.hasSession()).toBe(false)
  })

  it("does not attach or refresh credentials on an anonymous request", async () => {
    installBrowserGlobals("refresh-token-1")
    const client = await loadClient()

    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBeNull()
      return json(401, { code: "INVALID_CREDENTIALS", message: "nope", requestId: "req-1" })
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      client.api("/identity/auth/login", { method: "POST", body: {}, anonymous: true })
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" })

    // A 401 from the login route means bad credentials, not an expired token.
    // Refreshing here would be nonsense, and would burn a rotation.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("ApiError", () => {
  it("carries the request id and names the seats another buyer took", async () => {
    installBrowserGlobals(null)
    const client = await loadClient()

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(409, {
          code: "SEATS_UNAVAILABLE",
          message: "Some seats are no longer available",
          requestId: "req-409",
          details: {
            requestedSeatIds: ["a", "b", "c"],
            unavailableSeatIds: ["b", "c"],
          },
        })
      )
    )

    await expect(client.api("/reservations", { method: "POST", body: {} })).rejects.toSatisfy(
      (error: unknown) => {
        const apiError = error as InstanceType<typeof client.ApiError>
        expect(apiError.status).toBe(409)
        expect(apiError.code).toBe("SEATS_UNAVAILABLE")
        expect(apiError.requestId).toBe("req-409")
        // PRD §8.1 — the UI greys exactly these, rather than refetching blind.
        expect(apiError.unavailableSeatIds).toEqual(["b", "c"])
        return true
      }
    )
  })
})
