"use client"

import * as React from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ArrowLeftIcon, ClockIcon, LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Seatmap, SeatmapLegend, type SeatCell } from "@/components/seatmap"
import { api, ApiError } from "@/lib/api"
import { useSession } from "@/lib/auth"
import { useAvailability, useEvent } from "@/lib/queries"
import { formatCountdown, formatPaise } from "@/lib/format"
import {
  createHold,
  fetchHold,
  forgetHold,
  recallHold,
  releaseHold,
  rememberHold,
  useCountdown,
  MIN_SECONDS_TO_START_PAYMENT,
} from "@/lib/hold"
import type { PlacedOrder } from "@/lib/api-types"

const MAX_SEATS = 10 // MAX_SEATS_PER_HOLD in the reservation service.

export default function SeatsPage() {
  const { id: eventId } = useParams<{ id: string }>()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { isAuthenticated, isLoading: sessionLoading } = useSession()

  const { data: event } = useEvent(eventId)
  const { data: availability, isLoading: seatsLoading } = useAvailability(eventId, {
    limit: 5000,
    refetchMs: 8000,
  })

  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  /*
   * seatId → tierId, kept alongside the selection.
   *
   * `/availability` returns only *free* seats, so the moment a hold succeeds the
   * held seats vanish from it — and a total priced by looking seats up there
   * collapses to ₹0 exactly when the buyer is about to pay. The tier travels with
   * the selection instead: from the seatmap cell when picking, and from
   * `GET /reservations/:holdId` when restoring after a reload.
   */
  const [seatTiers, setSeatTiers] = React.useState<Map<string, string>>(new Map())
  const [lostSeatIds, setLostSeatIds] = React.useState<Set<string>>(new Set())
  const [holdId, setHoldId] = React.useState<string | null>(null)
  const [expiresAt, setExpiresAt] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const secondsLeft = useCountdown(expiresAt)
  const hasHold = holdId !== null && secondsLeft > 0

  /* ── restore a hold across a reload (the Phase 6a route) ────────────────── */
  React.useEffect(() => {
    const remembered = recallHold(eventId)
    if (remembered === null) return

    let cancelled = false
    void fetchHold(remembered)
      .then((hold) => {
        if (cancelled) return
        if (hold.status !== "active" || new Date(hold.expiresAt).getTime() <= Date.now()) {
          forgetHold(eventId)
          return
        }
        setHoldId(hold.holdId)
        setExpiresAt(hold.expiresAt)
        setSelected(new Set(hold.seats.map((seat) => seat.seatId)))
        setSeatTiers(new Map(hold.seats.map((seat) => [seat.seatId, seat.tierId])))
      })
      .catch(() => {
        // Gone, expired or not ours any more. Start clean.
        forgetHold(eventId)
      })

    return () => {
      cancelled = true
    }
  }, [eventId])

  /* ── the countdown reaching zero releases the seats ─────────────────────── */
  const releasedRef = React.useRef(false)
  React.useEffect(() => {
    if (holdId === null || expiresAt === null) return
    if (secondsLeft > 0) {
      releasedRef.current = false
      return
    }
    if (releasedRef.current) return
    releasedRef.current = true

    /*
     * PRD §13 — "auto-releases on hit zero".
     *
     * This is a courtesy, not the mechanism. The seats are already free the
     * instant the deadline passes, because expiry is a query predicate and not
     * a job (ADR-003): another buyer can take them whether or not this request
     * ever arrives. So its failure is ignored deliberately.
     */
    void releaseHold(holdId).catch(() => undefined)
    forgetHold(eventId)
    setHoldId(null)
    setExpiresAt(null)
    setSelected(new Set())
    setSeatTiers(new Map())
    toast.warning("Your hold expired", {
      description: "The seats went back on sale. Pick them again if they are still free.",
    })
    void queryClient.invalidateQueries({ queryKey: ["availability", eventId] })
  }, [secondsLeft, holdId, expiresAt, eventId, queryClient])

  const toggleSeat = (cell: SeatCell): void => {
    if (cell.seatId === null || hasHold) return
    const seatId = cell.seatId
    setLostSeatIds(new Set())
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(seatId)) {
        next.delete(seatId)
        setSeatTiers((tiers) => {
          const updated = new Map(tiers)
          updated.delete(seatId)
          return updated
        })
      } else if (next.size >= MAX_SEATS) {
        toast.error(`You can hold at most ${MAX_SEATS} seats at a time`)
        return current
      } else {
        next.add(seatId)
        setSeatTiers((tiers) => new Map(tiers).set(seatId, cell.tierId))
      }
      return next
    })
  }

  const onHold = async (): Promise<void> => {
    if (selected.size === 0) return
    if (!isAuthenticated) {
      router.push(`/login?next=/events/${eventId}/seats`)
      return
    }

    setBusy(true)
    setLostSeatIds(new Set())
    try {
      const hold = await createHold({
        eventId,
        seatIds: [...selected],
        // PRD §8.1 — a retried request must not produce a second hold.
        idempotencyKey: crypto.randomUUID(),
      })
      setHoldId(hold.holdId)
      setExpiresAt(hold.expiresAt)
      setSelected(new Set(hold.seatIds))
      rememberHold(eventId, hold.holdId)
      toast.success(`${hold.seatIds.length} seat${hold.seatIds.length === 1 ? "" : "s"} held`)
    } catch (error) {
      if (error instanceof ApiError && error.code === "SEATS_UNAVAILABLE") {
        /*
         * The 409 names exactly which seats went (PRD §8.1). Greying precisely
         * those is far better than a generic "try again": the buyer keeps the
         * seats they still have a chance at, and immediately sees what they lost.
         */
        const lost = new Set(error.unavailableSeatIds)
        setLostSeatIds(lost)
        setSelected((current) => new Set([...current].filter((id) => !lost.has(id))))
        toast.error("Someone else took those seats", {
          description: `${lost.size} of your ${selected.size} seats went to another buyer.`,
        })
      } else if (error instanceof ApiError) {
        toast.error(error.message, { description: error.requestId })
      } else {
        toast.error("Could not reach the ticketing service")
      }
      void queryClient.invalidateQueries({ queryKey: ["availability", eventId] })
    } finally {
      setBusy(false)
    }
  }

  const onRelease = async (): Promise<void> => {
    if (holdId === null) return
    setBusy(true)
    try {
      await releaseHold(holdId)
      forgetHold(eventId)
      setHoldId(null)
      setExpiresAt(null)
      setSelected(new Set())
      setSeatTiers(new Map())
      void queryClient.invalidateQueries({ queryKey: ["availability", eventId] })
      toast.success("Seats released")
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not release the hold")
    } finally {
      setBusy(false)
    }
  }

  const onCheckout = async (): Promise<void> => {
    if (holdId === null) return
    setBusy(true)
    try {
      const order = await api<PlacedOrder>("/orders", {
        method: "POST",
        body: { holdId },
        /*
         * Derived from the hold, NOT random.
         *
         * A fresh key on every press asks for a brand new order each time, and
         * the second one collides with `orders_one_live_per_hold` — the buyer
         * dead-ends on a 409 while their seats sit held until expiry. Keyed on
         * the hold, a second press replays the first order instead, which is
         * what Idempotency-Key is for (PRD §10.1).
         */
        idempotencyKey: `order-${holdId}`,
      })
      forgetHold(eventId)
      router.push(`/checkout/${order.orderId}`)
    } catch (error) {
      if (error instanceof ApiError && error.code === "CONFLICT") {
        // An order exists for this hold from before the idempotency key was
        // keyed on the hold. Say what to do rather than showing a bare error.
        toast.error("This hold already has an order", {
          description: "Release these seats and pick them again to start over.",
        })
      } else if (error instanceof ApiError) {
        toast.error(error.message, { description: error.requestId })
      } else {
        toast.error("Could not start checkout")
      }
      setBusy(false)
    }
  }

  const tiersById = React.useMemo(() => {
    const map = new Map<string, number>()
    for (const tier of event?.tiers ?? []) map.set(tier.tier_id, tier.price_paise)
    return map
  }, [event])

  const selectedTotal = React.useMemo(() => {
    let total = 0
    for (const seatId of selected) {
      const tierId = seatTiers.get(seatId)
      if (tierId !== undefined) total += tiersById.get(tierId) ?? 0
    }
    return total
  }, [selected, seatTiers, tiersById])

  const holdWindow = event?.hold_duration_seconds ?? 480
  const tooLateToPay = hasHold && secondsLeft < MIN_SECONDS_TO_START_PAYMENT

  return (
    <div className="flex flex-col gap-6">
      <Button variant="ghost" size="sm" className="self-start px-0" asChild>
        <Link href={`/events/${eventId}`}>
          <ArrowLeftIcon className="size-4" />
          {event?.title ?? "Back to event"}
        </Link>
      </Button>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="gap-3">
            <CardTitle>Choose your seats</CardTitle>
            <SeatmapLegend />
          </CardHeader>
          <CardContent>
            {seatsLoading || event === undefined ? (
              <Skeleton className="h-[420px] w-full" />
            ) : (
              <ScrollArea className="h-[560px] rounded-md border p-3">
                <Seatmap
                  event={event}
                  availableSeats={availability?.seats ?? []}
                  selected={selected}
                  lostSeatIds={lostSeatIds}
                  disabled={hasHold || busy}
                  onToggle={toggleSeat}
                />
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:h-fit">
          {hasHold && (
            <Card className={tooLateToPay ? "border-destructive" : "border-primary"}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ClockIcon className="size-4" />
                  Held for {formatCountdown(secondsLeft)}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Progress value={(secondsLeft / holdWindow) * 100} />
                <p className="text-xs text-muted-foreground">
                  These seats are yours until the timer runs out. After that they go back on
                  sale automatically — nothing needs to run for that to happen.
                </p>
                {tooLateToPay && (
                  <Alert variant="destructive">
                    <AlertTitle>Not enough time left to pay</AlertTitle>
                    <AlertDescription>
                      Checkout needs at least {MIN_SECONDS_TO_START_PAYMENT} seconds on the
                      hold. Release these and pick them again.
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {selected.size === 0
                  ? "No seats selected"
                  : `${selected.size} seat${selected.size === 1 ? "" : "s"}`}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {selected.size > 0 && (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Total</span>
                    <span className="text-lg font-semibold tabular-nums">
                      {formatPaise(selectedTotal)}
                    </span>
                  </div>
                  <Separator />
                </>
              )}

              {lostSeatIds.size > 0 && (
                <Alert variant="destructive">
                  <AlertTitle>{lostSeatIds.size} seats were taken</AlertTitle>
                  <AlertDescription>
                    Another buyer got there first. They are marked in red.
                  </AlertDescription>
                </Alert>
              )}

              {!sessionLoading && !isAuthenticated && (
                <Alert>
                  <AlertTitle>Sign in to hold seats</AlertTitle>
                  <AlertDescription>
                    You can browse freely, but holding a seat needs an account.
                  </AlertDescription>
                </Alert>
              )}

              {hasHold ? (
                <div className="flex flex-col gap-2">
                  <Button size="lg" disabled={busy || tooLateToPay} onClick={() => void onCheckout()}>
                    {busy && <LoaderCircleIcon className="size-4 animate-spin" />}
                    Pay {formatPaise(selectedTotal)}
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => void onRelease()}>
                    Release seats
                  </Button>
                </div>
              ) : (
                <Button
                  size="lg"
                  disabled={selected.size === 0 || busy}
                  onClick={() => void onHold()}
                >
                  {busy && <LoaderCircleIcon className="size-4 animate-spin" />}
                  Hold {selected.size > 0 ? `${selected.size} ` : ""}seat
                  {selected.size === 1 ? "" : "s"}
                </Button>
              )}

              <p className="text-xs text-muted-foreground">
                <Badge variant="secondary" className="mr-1">
                  {availability?.available?.toLocaleString("en-IN") ?? "—"}
                </Badge>
                seats free right now
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
