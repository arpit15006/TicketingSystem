"use client"

import * as React from "react"
import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { ClockIcon, LoaderCircleIcon, LockIcon, ShieldCheckIcon, UserIcon } from "lucide-react"
import { BookingSteps } from "@/components/booking-steps"
import { EventPoster } from "@/components/event-card"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { api, ApiError } from "@/lib/api"
import { useSession } from "@/lib/auth"
import { useEvent } from "@/lib/queries"
import { fetchHold, useCountdown } from "@/lib/hold"
import { formatCountdown, formatEventDate, formatPaise } from "@/lib/format"
import { loadRazorpay, openRazorpay, type RazorpayHandlerResponse } from "@/lib/razorpay"
import type { OrderDetail } from "@/lib/api-types"

/**
 * PRD §10.1 — the Razorpay handoff.
 *
 * The order was created with `payment_capture: 0` (ADR-007), so Checkout only
 * ever *authorizes*. Nothing is captured until the seat is provably ours, and
 * if it is lost in between the authorization is voided — no money moves.
 *
 * The browser's success callback is not evidence of anything; it is posted to
 * `/orders/:id/verify`, where the signature is checked with a secret this page
 * does not have (§10.1.7).
 */
export default function CheckoutPage() {
  const { orderId } = useParams<{ orderId: string }>()
  const router = useRouter()
  const { user } = useSession()
  const [paying, setPaying] = React.useState(false)

  const { data: order, isLoading, error } = useQuery({
    queryKey: ["order", orderId],
    queryFn: async () => api<OrderDetail>(`/orders/${orderId}`),
  })
  const { data: event } = useEvent(order?.eventId ?? "")
  // The hold behind the order: its seats (for the itemised bill) and its
  // deadline (orders extended it when the order was placed, PRD §10.1.4).
  const { data: hold } = useQuery({
    queryKey: ["hold", order?.holdId],
    queryFn: async () => fetchHold(order?.holdId ?? ""),
    enabled: order !== undefined,
    refetchInterval: 30_000,
  })
  const secondsLeft = useCountdown(hold?.status === "active" ? hold.expiresAt : null)
  const holdExpired = hold !== undefined && hold.status === "active" && secondsLeft <= 0

  React.useEffect(() => {
    if (order === undefined) return
    if (order.status === "confirmed" || order.status === "refunded_seat_lost") router.replace(`/orders/${orderId}`)
  }, [order, orderId, router])

  const lines = React.useMemo(() => {
    if (hold === undefined || event === undefined) return []
    const byTier = new Map<string, number>()
    for (const seat of hold.seats) byTier.set(seat.tierId, (byTier.get(seat.tierId) ?? 0) + 1)
    return event.tiers
      .filter((t) => byTier.has(t.tier_id))
      .map((t) => ({ name: t.name, count: byTier.get(t.tier_id) ?? 0, pricePaise: t.price_paise }))
  }, [hold, event])

  const startPayment = async (): Promise<void> => {
    if (order === undefined) return
    setPaying(true)
    try {
      await loadRazorpay()
      if (order.razorpayOrderId === null) {
        toast.error("This order has no payment attached yet")
        setPaying(false)
        return
      }
      openRazorpay({
        key: order.razorpayKeyId,
        amount: order.amountPaise,
        currency: "INR",
        order_id: order.razorpayOrderId,
        name: "Ticketing",
        description: event?.title ?? `${order.seatIds.length} seat${order.seatIds.length === 1 ? "" : "s"}`,
        ...(user === null ? {} : { prefill: { name: user.fullName, email: user.email } }),
        handler: (response: RazorpayHandlerResponse) => {
          void (async () => {
            try {
              await api(`/orders/${orderId}/verify`, {
                method: "POST",
                body: {
                  razorpayOrderId: response.razorpay_order_id,
                  razorpayPaymentId: response.razorpay_payment_id,
                  razorpaySignature: response.razorpay_signature,
                },
              })
            } catch (verifyError) {
              // A 410 here is the compensation path: paid, seat lost. The order
              // page explains it properly.
              if (verifyError instanceof ApiError) toast.error(verifyError.message, { description: verifyError.requestId })
            }
            router.push(`/orders/${orderId}`)
          })()
        },
        modal: { ondismiss: () => setPaying(false) },
      })
    } catch (startError) {
      toast.error(startError instanceof ApiError ? startError.message : "Could not start the payment")
      setPaying(false)
    }
  }

  if (error instanceof ApiError) {
    return (
      <Alert variant="destructive" className="mx-auto max-w-md">
        <AlertTitle>{error.message}</AlertTitle>
        <AlertDescription>
          <span className="font-mono text-xs">{error.requestId}</span>
        </AlertDescription>
      </Alert>
    )
  }
  if (isLoading || order === undefined) return <Skeleton className="mx-auto h-96 w-full max-w-3xl rounded-xl" />

  const holdWindow = event?.hold_duration_seconds ?? 480

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <BookingSteps current={2} />

      <div className="grid gap-6 md:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-4">
          {/* ── what you're buying ─────────────────────────────────────── */}
          <Card className="overflow-hidden p-0">
            <div className="relative h-28">
              {event !== undefined ? <EventPoster event={event} className="absolute inset-0" /> : <Skeleton className="absolute inset-0 rounded-none" />}
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
              <div className="relative flex h-full flex-col justify-end p-4 text-white">
                <h1 className="text-lg font-bold">{event?.title ?? "…"}</h1>
                {event !== undefined && <p className="text-xs text-white/85">{formatEventDate(event.starts_at)}</p>}
              </div>
            </div>
            <CardContent className="flex flex-col gap-3 p-4">
              {lines.length === 0 ? (
                <Skeleton className="h-12 w-full" />
              ) : (
                lines.map((line) => (
                  <div key={line.name} className="flex items-center justify-between text-sm">
                    <span>
                      {line.count} × {line.name}
                      <span className="text-muted-foreground"> @ {formatPaise(line.pricePaise)}</span>
                    </span>
                    <span className="tabular-nums">{formatPaise(line.count * line.pricePaise)}</span>
                  </div>
                ))
              )}
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>Convenience fee</span>
                <span className="tabular-nums">₹0</span>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <span className="font-medium">Total</span>
                <span className="text-xl font-semibold tabular-nums">{formatPaise(order.amountPaise)}</span>
              </div>
              <p className="text-xs text-muted-foreground">All prices inclusive. No hidden charges at any step.</p>
            </CardContent>
          </Card>

          {/* ── who's buying ───────────────────────────────────────────── */}
          <Item variant="outline">
            <ItemMedia variant="icon">
              <UserIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{user?.fullName ?? "…"}</ItemTitle>
              <ItemDescription>{user?.email ?? ""} · tickets are issued to this account</ItemDescription>
            </ItemContent>
          </Item>
        </div>

        {/* ── pay ────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 md:sticky md:top-20 md:h-fit">
          {hold?.status === "active" && (
            <Card className={holdExpired ? "border-destructive" : ""}>
              <CardContent className="flex flex-col gap-2 pt-6">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <ClockIcon className="size-4" />
                    Complete payment in
                  </span>
                  <span className="font-semibold tabular-nums">{formatCountdown(secondsLeft)}</span>
                </div>
                <Progress value={Math.min(100, (secondsLeft / Math.max(holdWindow, 600)) * 100)} />
                {holdExpired && (
                  <p className="text-xs text-destructive">
                    The hold expired. The seats are back on sale —{" "}
                    <Link href={`/events/${order.eventId}/seats`} className="underline">
                      pick them again
                    </Link>
                    .
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pay securely</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Button size="lg" onClick={() => void startPayment()} disabled={paying || holdExpired}>
                {paying ? <LoaderCircleIcon className="size-4 animate-spin" /> : <LockIcon className="size-4" />}
                Pay {formatPaise(order.amountPaise)}
              </Button>
              <div className="flex flex-wrap gap-1.5">
                {["UPI", "Cards", "Netbanking", "Wallets"].map((m) => (
                  <Badge key={m} variant="secondary">{m}</Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">via Razorpay · test mode</p>
              <Separator />
              <div className="flex gap-2 text-xs text-muted-foreground">
                <ShieldCheckIcon className="size-4 shrink-0" />
                <span>
                  Authorized now, charged only once your seat is confirmed. If the seat is lost in between, the
                  authorization is released — nothing to refund.
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
