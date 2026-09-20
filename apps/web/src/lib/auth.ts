"use client"

import * as React from "react"
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { api } from "./api"
import type { AuthResult, CurrentUser, Role } from "./api-types"
import {
  clearTokens,
  getRefreshToken,
  hasSession,
  storeTokens,
  subscribeToTokens,
} from "./tokens"

export const SESSION_QUERY_KEY = ["session"] as const

export async function login(email: string, password: string): Promise<AuthResult> {
  const result = await api<AuthResult>("/identity/auth/login", {
    method: "POST",
    body: { email, password },
    anonymous: true,
  })
  storeTokens(result)
  return result
}

export async function register(args: {
  email: string
  password: string
  fullName: string
}): Promise<AuthResult> {
  const result = await api<AuthResult>("/identity/auth/register", {
    method: "POST",
    body: args,
    anonymous: true,
  })
  storeTokens(result)
  return result
}

/**
 * PRD §9.1 — logout revokes the refresh family *and* denylists the access token's
 * `jti`, because the access token stays cryptographically valid for up to ten
 * minutes. Dropping the tokens locally without telling identity would make "log
 * out" a lie for that window.
 *
 * The local clear happens regardless: if the network call fails, the user still
 * expects to be logged out of this browser.
 */
export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken()
  try {
    if (refreshToken !== null) {
      await api<void>("/identity/auth/logout", {
        method: "POST",
        body: { refreshToken },
      })
    }
  } catch {
    // Already-revoked or offline. Nothing useful to surface.
  } finally {
    clearTokens()
  }
}

/** Re-renders whenever tokens change, without mirroring them into state. */
function useHasSession(): boolean {
  return React.useSyncExternalStore(
    subscribeToTokens,
    hasSession,
    // No credentials exist during a server render.
    () => false
  )
}

export interface Session {
  user: CurrentUser | null
  isLoading: boolean
  isAuthenticated: boolean
}

export function useSession(): Session {
  const authenticated = useHasSession()

  const query: UseQueryResult<CurrentUser> = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => api<CurrentUser>("/identity/me"),
    enabled: authenticated,
    // The roles claim drives what the nav shows; a stale one is confusing but
    // never a security decision — every service re-checks permission itself
    // (ADR-010).
    staleTime: 60_000,
    retry: false,
  })

  return {
    user: query.data ?? null,
    isLoading: authenticated && query.isLoading,
    isAuthenticated: authenticated && query.data !== undefined,
  }
}

/** Invalidate the cached session after a login, logout or role change. */
export function useRefreshSession(): () => void {
  const client = useQueryClient()
  return React.useCallback(() => {
    void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY })
  }, [client])
}

/* ───────────────────────────── role helpers ──────────────────────────────── */

/**
 * These decide what the UI *offers*, never what it *allows*. Authorization is
 * enforced by the service that owns the resource (ADR-010); hiding a link the
 * server would refuse is a courtesy, not a control.
 */
export function hasRole(user: CurrentUser | null, role: Role): boolean {
  return user?.roles.some((grant) => grant.role === role) ?? false
}

export function isPlatformAdmin(user: CurrentUser | null): boolean {
  return (
    user?.roles.some(
      (grant) => grant.role === "platform_admin" && grant.resourceType === null
    ) ?? false
  )
}

/** Events this user could plausibly manage — drives the organizer dashboard. */
export function organizedEventIds(user: CurrentUser | null): string[] {
  return (
    user?.roles
      .filter(
        (grant) =>
          grant.role === "organizer" &&
          grant.resourceType === "event" &&
          grant.resourceId !== null
      )
      .map((grant) => grant.resourceId as string) ?? []
  )
}

export function scannableEventIds(user: CurrentUser | null): string[] {
  return (
    user?.roles
      .filter(
        (grant) =>
          grant.role === "scanner" &&
          grant.resourceType === "event" &&
          grant.resourceId !== null
      )
      .map((grant) => grant.resourceId as string) ?? []
  )
}
