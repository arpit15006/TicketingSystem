import type { TokenPair } from "./api-types"

/**
 * Where the two tokens live, and why they live in different places.
 *
 * PRD §9.1 gives the access token a 10-minute TTL and the refresh token 14 days
 * with rotation on every use. That difference drives the storage:
 *
 *  - **Access token — memory only.** It is short-lived and replaceable, so there
 *    is nothing to gain by persisting it. A reload simply mints a new one from
 *    the refresh token.
 *
 *  - **Refresh token — localStorage.** It has to survive a reload, and the
 *    browser talks to the gateway directly (no cookie-issuing origin of our own),
 *    so there is nowhere httpOnly to put it. This is a real trade: script running
 *    on this page can read it. It is the accepted cost of the direct-to-gateway
 *    model, and it is why rotation and reuse detection (ADR-011) matter — a
 *    stolen token is detectable the moment the real client next refreshes.
 */

const REFRESH_STORAGE_KEY = "ticketing.refreshToken"

let accessToken: string | null = null

type Listener = () => void
const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Subscribe to auth changes — the shape `useSyncExternalStore` wants. */
export function subscribeToTokens(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getAccessToken(): string | null {
  return accessToken
}

/**
 * Storage can throw or return null in a private window, with site data blocked,
 * or during a server render. Every access is guarded, and the app stays usable
 * without it — the session just does not survive a reload.
 */
export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(REFRESH_STORAGE_KEY)
  } catch {
    return null
  }
}

export function storeTokens(pair: Pick<TokenPair, "accessToken" | "refreshToken">): void {
  accessToken = pair.accessToken
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(REFRESH_STORAGE_KEY, pair.refreshToken)
    } catch {
      // Non-fatal: the session works until the tab closes.
    }
  }
  notify()
}

export function clearTokens(): void {
  accessToken = null
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(REFRESH_STORAGE_KEY)
    } catch {
      // Nothing to do; the token was unreadable anyway.
    }
  }
  notify()
}

/** True when there is any credential at all — an access token or a way to get one. */
export function hasSession(): boolean {
  return accessToken !== null || getRefreshToken() !== null
}
