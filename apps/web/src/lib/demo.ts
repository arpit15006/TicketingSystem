"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  LayoutDashboardIcon,
  ScanLineIcon,
  ShieldCheckIcon,
  TicketIcon,
  type LucideIcon,
} from "lucide-react"
import { logout, useRefreshSession } from "./auth"
import { hasSession, storeTokens } from "./tokens"

/** One mark per role, so a role looks the same wherever it is offered. */
export const DEMO_ICONS: Record<string, LucideIcon> = {
  attendee: TicketIcon,
  organizer: LayoutDashboardIcon,
  scanner: ScanLineIcon,
  platform_admin: ShieldCheckIcon,
}

export interface DemoAccount {
  role: string
  label: string
  blurb: string
  email: string
  landing: string
}

/**
 * The demo accounts this deployment offers, or `null` while that is still
 * unknown. An empty array is a real answer: it means the doors are shut
 * (`DEMO_LOGINS=0`, or no admin credential given), and callers render nothing.
 */
export function useDemoAccounts(): DemoAccount[] | null {
  const [accounts, setAccounts] = React.useState<DemoAccount[] | null>(null)

  React.useEffect(() => {
    let live = true
    void (async () => {
      try {
        const r = await fetch("/api/demo-login")
        const body = (await r.json()) as { accounts?: DemoAccount[] }
        if (live) setAccounts(body.accounts ?? [])
      } catch {
        if (live) setAccounts([])
      }
    })()
    return () => {
      live = false
    }
  }, [])

  return accounts
}

export interface DemoSignIn {
  signIn: (account: DemoAccount) => Promise<void>
  /** The role currently being signed in, so a row can show its own spinner. */
  busy: string | null
  error: string | null
}

/**
 * Signs in as a demo account and lands on the work that role does.
 *
 * No passphrase passes through here: the request carries a role name, and the
 * server returns the same token pair `POST /identity/auth/login` would have.
 *
 * Switching roles from a live session logs the old one out properly first —
 * dropping its tokens locally would leave the refresh family valid on the
 * server, which is exactly the lie PRD §9.1 says logout must not tell.
 */
export function useDemoSignIn(onStart?: () => void): DemoSignIn {
  const router = useRouter()
  const refreshSession = useRefreshSession()
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const signIn = async (account: DemoAccount): Promise<void> => {
    setBusy(account.role)
    setError(null)
    onStart?.()
    try {
      if (hasSession()) await logout()

      const r = await fetch("/api/demo-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: account.role }),
      })
      const body = (await r.json()) as {
        accessToken?: string
        refreshToken?: string
        error?: string
      }
      if (!r.ok || body.accessToken === undefined || body.refreshToken === undefined) {
        setError(body.error ?? "That demo account could not sign in")
        return
      }
      storeTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken })
      refreshSession()
      router.replace(account.landing)
    } catch {
      setError("The demo sign-in could not be reached")
    } finally {
      setBusy(null)
    }
  }

  return { signIn, busy, error }
}
