"use client"

import * as React from "react"
import { api, ApiError } from "./api"
import type { Hold, HoldDetail } from "./api-types"

/**
 * A hold is the only piece of client state with a deadline attached, so it gets
 * its own module.
 *
 * Two things matter and both are easy to get wrong:
 *
 *  1. **The deadline is the server's, never ours.** `expiresAt` comes from the
 *     service that owns the seat; the countdown only renders it. A client that
 *     derived the deadline from its own clock would drift, and would keep a dead
 *     hold on screen after the seats had already gone back on sale.
 *
 *  2. **A reload must not orphan a hold.** The hold id is kept in sessionStorage
 *     and re-read from `GET /reservations/:holdId` on mount, which is the
 *     owner-scoped route added in Phase 6a precisely for this. Without it the
 *     seats would sit held, invisible to the buyer who holds them, until expiry.
 */

const storageKey = (eventId: string): string => `ticketing.hold.${eventId}`

export function rememberHold(eventId: string, holdId: string): void {
  try {
    window.sessionStorage.setItem(storageKey(eventId), holdId)
  } catch {
    // Non-fatal: the countdown just will not survive a reload.
  }
}

export function forgetHold(eventId: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(eventId))
  } catch {
    // Nothing to clean up.
  }
}

export function recallHold(eventId: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(eventId))
  } catch {
    return null
  }
}

export async function createHold(args: {
  eventId: string
  seatIds: string[]
  idempotencyKey: string
  admissionToken?: string
}): Promise<Hold> {
  return api<Hold>("/reservations", {
    method: "POST",
    body: { eventId: args.eventId, seatIds: args.seatIds },
    idempotencyKey: args.idempotencyKey,
    ...(args.admissionToken === undefined ? {} : { admissionToken: args.admissionToken }),
  })
}

export async function releaseHold(holdId: string): Promise<void> {
  await api<{ holdId: string }>(`/reservations/${holdId}`, { method: "DELETE" })
}

export async function fetchHold(holdId: string): Promise<HoldDetail> {
  return api<HoldDetail>(`/reservations/${holdId}`)
}

/**
 * Seconds left on a deadline, ticking once a second and never below zero.
 *
 * `Date.now()` is read on every tick rather than a counter being decremented:
 * a decremented counter drifts, and stops entirely when the tab is backgrounded
 * and timers are throttled — so the user would come back to a countdown that
 * still showed time on a hold the server released minutes ago.
 */
export function useCountdown(expiresAt: string | null): number {
  const deadline = expiresAt === null ? null : new Date(expiresAt).getTime()

  // Only a re-render trigger. The remaining time is *derived* below rather than
  // stored, so there is no second copy of the truth to fall out of step — and
  // nothing is assigned inside the effect body.
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (deadline === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [deadline])

  if (deadline === null) return 0
  return Math.max(0, (deadline - now) / 1000)
}

/** True once the server would refuse to start a payment (PRD §10.1.3). */
export const MIN_SECONDS_TO_START_PAYMENT = 90

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}
