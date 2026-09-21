"use client"

import * as React from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ArrowLeftIcon, ClockIcon, LoaderCircleIcon, SparklesIcon, ShoppingBagIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { BookingSteps } from "@/components/booking-steps"
import { SeatmapViewport } from "@/components/seatmap-viewport"
import { Seatmap, SeatmapLegend, findBestSeats, type HoverInfo, type SeatCell } from "@/components/seatmap"
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

  /*
   * PRD §12 — for a waiting-room event, the admission token minted by the queue
   * is what the gateway and reservation require on /reservations. It was stored
   * by the queue page; without it the only correct move is back to the queue.
   */
  // Read once, lazily: sessionStorage is an external store with no change
  // events, so mirroring it into state from an effect would only add a render.
  const [admissionToken] = React.useState<string | null>(() => {
    if (typeof window === "undefined") return null
    try {
      return window.sessionStorage.getItem(`ticketing.admission.${eventId}`)
    } catch {
      return null
    }
  })
  React.useEffect(() => {
    if (event === undefined || !event.waiting_room_enabled) return
    if (admissionToken === null) router.replace(`/events/${eventId}/queue`)
  }, [event, eventId, admissionToken, router])
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
  const [onlyTierId, setOnlyTierId] = React.useState<string | null>(null)
  const [hover, setHover] = React.useState<HoverInfo | null>(null)
  const [bestCount, setBestCount] = React.useState(2)
  const mapRef = React.useRef<HTMLDivElement>(null)

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

  /** "Best available": N seats together, closest to the stage, in the chosen tier. */
  const pickBest = (): void => {
    if (event === undefined || hasHold) return
    const ids = findBestSeats(event, availability?.seats ?? [], bestCount, onlyTierId)
    if (ids.length === 0) {
      toast.error(`No ${bestCount} seats together${onlyTierId === null ? "" : " in that tier"}`)
      return
    }
    const tierOf = new Map((availability?.seats ?? []).map((seat) => [seat.seat_id, seat.tier_id]))
    setLostSeatIds(new Set())
    setSelected(new Set(ids))
    setSeatTiers(new Map(ids.map((id) => [id, tierOf.get(id) ?? ""])))
    toast.success(`Picked ${ids.length} seats together`)
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
        ...(admissionToken === null ? {} : { admissionToken }),
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
      } else if (error instanceof ApiError && error.code === "EVENT_NOT_ON_SALE") {
        toast.error("This event is not on sale yet")
        router.replace(`/events/${eventId}`)
      } else if (error instanceof ApiError && error.status === 403) {
        // Admission expired or was never granted: the queue is the way back in.
        toast.error("Your queue admission has expired", { description: "Rejoining the queue." })
        try {
          sessionStorage.removeItem(`ticketing.admission.${eventId}`)
        } catch {
          // nothing stored
        }
        router.replace(`/events/${eventId}/queue`)
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

  const basket = (
    <div className="flex flex-col gap-4">
      {hasHold && (
        <Card className={tooLateToPay ? "border-destructive" : "border-primary"}>
          <CardHeader>
            <CardTitle asChild className="flex items-center gap-2 text-base">
              <h2>
                <ClockIcon className="size-4" />
                Held for {formatCountdown(secondsLeft)}
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Progress value={(secondsLeft / holdWindow) * 100} />
            <p className="text-xs text-muted-foreground">
              Yours until the timer runs out. Then they go back on sale automatically — nothing needs to run
              for that to happen.
            </p>
            {tooLateToPay && (
              <Alert variant="destructive">
                <AlertTitle>Not enough time left to pay</AlertTitle>
                <AlertDescription>
                  Checkout needs at least {MIN_SECONDS_TO_START_PAYMENT} seconds on the hold. Release these and
                  pick them again.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle asChild className="text-base">
            <h2>{selected.size === 0 ? "No seats selected" : `${selected.size} seat${selected.size === 1 ? "" : "s"}`}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {selected.size > 0 && (
            <>
              <ul className="flex flex-col gap-1 text-sm">
                {(availability?.seats ?? [])
                  .filter((seat) => selected.has(seat.seat_id))
                  .map((seat) => (
                    <li key={seat.seat_id} className="flex justify-between">
                      <span>
                        {seat.section} · Row {seat.row_label.slice(1)} · Seat {seat.seat_number}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatPaise(tiersById.get(seat.tier_id) ?? 0)}
                      </span>
                    </li>
                  ))}
                {hasHold && (availability?.seats ?? []).filter((seat) => selected.has(seat.seat_id)).length === 0 && (
                  <li className="text-muted-foreground">{selected.size} held seats</li>
                )}
              </ul>
              <Separator />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Total</span>
                <span className="text-lg font-semibold tabular-nums">{formatPaise(selectedTotal)}</span>
              </div>
            </>
          )}

          {lostSeatIds.size > 0 && (
            <Alert variant="destructive">
              <AlertTitle>{lostSeatIds.size} seats were taken</AlertTitle>
              <AlertDescription>Another buyer got there first. They are marked in red.</AlertDescription>
            </Alert>
          )}

          {!sessionLoading && !isAuthenticated && (
            <Alert>
              <AlertTitle>Sign in to hold seats</AlertTitle>
              <AlertDescription>You can browse freely, but holding a seat needs an account.</AlertDescription>
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
            <Button size="lg" disabled={selected.size === 0 || busy} onClick={() => void onHold()}>
              {busy && <LoaderCircleIcon className="size-4 animate-spin" />}
              Hold {selected.size > 0 ? `${selected.size} ` : ""}seat{selected.size === 1 ? "" : "s"}
            </Button>
          )}

        </CardContent>
      </Card>
    </div>
  )

  return (
    <div className="flex flex-col gap-6 pb-24">
      {/*
        The page had no heading at all — its only h-tags were the footer's — and
        the event title lived inside a ghost back-button, so nothing said where
        you were. The title is the h1 now; the back link is just a back link.
        The seat count moves up here too: it is the number that decides whether
        to keep looking, and it was 12px of muted text at the foot of a sidebar.
      */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/events/${eventId}`}>
              <ArrowLeftIcon className="size-4" />
              Back to event
            </Link>
          </Button>
          <BookingSteps current={1} />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{event?.title ?? "Choose your seats"}</h1>
          {availability !== undefined && (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">
                {availability.available.toLocaleString("en-IN")}
              </span>{" "}
              seats free right now
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle asChild>
                <h2>Choose your seats</h2>
              </CardTitle>
              {event !== undefined && event.tiers.length > 1 && (
                <ToggleGroup
                  type="single"
                  size="sm"
                  variant="outline"
                  value={onlyTierId ?? "all"}
                  onValueChange={(v) => v !== "" && setOnlyTierId(v === "all" ? null : v)}
                >
                  <ToggleGroupItem value="all">All tiers</ToggleGroupItem>
                  {event.tiers.map((tier) => (
                    <ToggleGroupItem key={tier.tier_id} value={tier.tier_id}>
                      {tier.name}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </div>
            <SeatmapLegend tiers={event?.tiers ?? []} />

            {/*
              "Best available" — N seats together, nearest the stage.
              A plain row of secondary controls: bordered and filled, this utility
              outweighed the tier filter above it, which is the primary way into
              the map.
            */}
            {!hasHold && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <SparklesIcon className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">Best available:</span>
                <NativeSelect value={String(bestCount)} onChange={(e) => setBestCount(Number(e.target.value))} className="w-24">
                  {Array.from({ length: MAX_SEATS }, (_, i) => (
                    <NativeSelectOption key={i + 1} value={String(i + 1)}>
                      {i + 1} seat{i === 0 ? "" : "s"}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Button type="button" size="sm" variant="outline" onClick={pickBest} disabled={seatsLoading || busy}>
                  Pick for me
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {seatsLoading || event === undefined ? (
              <Skeleton className="h-[560px] w-full" />
            ) : (
              <div ref={mapRef} className="relative">
                <SeatmapViewport>
                  <Seatmap
                    event={event}
                    availableSeats={availability?.seats ?? []}
                    selected={selected}
                    lostSeatIds={lostSeatIds}
                    onlyTierId={onlyTierId}
                    disabled={hasHold || busy}
                    onToggle={toggleSeat}
                    onHover={(info) => {
                      if (info === null) {
                        setHover(null)
                        return
                      }
                      const rect = mapRef.current?.getBoundingClientRect()
                      setHover({ ...info, clientX: info.clientX - (rect?.left ?? 0), clientY: info.clientY - (rect?.top ?? 0) })
                    }}
                  />
                </SeatmapViewport>

                {/* One floating tooltip for 5,000 seats — not 5,000 tooltips. */}
                {hover !== null && (
                  <div
                    className="pointer-events-none absolute z-10 rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md"
                    style={{ left: hover.clientX + 12, top: hover.clientY - 40 }}
                  >
                    <div className="font-medium">
                      {hover.section} · Row {hover.rowLabel.slice(1)} · Seat {hover.seatNumber}
                    </div>
                    <div className="opacity-80">
                      {hover.taken ? "Taken" : `${hover.tierName} · ${formatPaise(hover.pricePaise)}`}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Desktop: the basket beside the map. */}
        <div className="hidden lg:sticky lg:top-20 lg:block lg:h-fit">{basket}</div>
      </div>

      {/*
        The action bar, at every width — not just on phones.
        The sticky sidebar puts "Hold seats" ~700px from the seat being clicked
        on a large display: 556px up and 427px across. A bar pinned to the
        bottom keeps the confirmation next to the selection wherever the pointer
        is. It appears only once there is something to act on, so an untouched
        map is not covered by a disabled button.
      */}
      {(selected.size > 0 || hasHold) && (
      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 backdrop-blur">
        {/*
          A centred cluster, not a justify-between row. Pushed to the far right
          the button was 548px across from a seat in the middle of the map —
          further than the sidebar it replaced. Centred, the action sits under
          the map it belongs to.
        */}
        <div className="mx-auto flex w-fit items-center gap-4">
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {hasHold ? `Held · ${formatCountdown(secondsLeft)}` : `${selected.size} seat${selected.size === 1 ? "" : "s"}`}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">{formatPaise(selectedTotal)}</span>
          </div>
          <Drawer>
            <DrawerTrigger asChild>
              <Button variant="outline" size="sm">
                <ShoppingBagIcon className="size-4" />
                Details
              </Button>
            </DrawerTrigger>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>Your seats</DrawerTitle>
                <DrawerDescription>{event?.title}</DrawerDescription>
              </DrawerHeader>
              <div className="overflow-y-auto px-4 pb-6">{basket}</div>
            </DrawerContent>
          </Drawer>
          {hasHold ? (
            <Button size="lg" disabled={busy || tooLateToPay} onClick={() => void onCheckout()}>
              Pay {formatPaise(selectedTotal)}
            </Button>
          ) : (
            <Button size="lg" disabled={busy} onClick={() => void onHold()}>
              Hold {selected.size} seat{selected.size === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
