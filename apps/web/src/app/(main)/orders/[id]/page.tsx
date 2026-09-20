"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import QRCode from "react-qr-code"
import { CalendarIcon, CalendarPlusIcon, CheckCircle2Icon, CircleAlertIcon, ClockIcon, MapPinIcon, PrinterIcon } from "lucide-react"
import { ShareButton } from "@/components/share-button"
import { downloadIcs } from "@/lib/calendar"
import { EventPoster } from "@/components/event-card"
import { BookingSteps } from "@/components/booking-steps"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { api, ApiError } from "@/lib/api"
import { useEvent } from "@/lib/queries"
import { formatEventDate, formatPaise } from "@/lib/format"
import type { OrderDetail, OrderStatus } from "@/lib/api-types"

const LABELS: Record<OrderStatus, string> = {
  created: "Starting",
  awaiting_payment: "Awaiting payment",
  payment_authorized: "Payment authorized",
  confirmed: "Confirmed",
  compensating: "Releasing your payment",
  refunded_seat_lost: "Payment released — seat lost",
  failed: "Failed",
  cancelled: "Cancelled",
}

export default function OrderPage() {
  const { id: orderId } = useParams<{ id: string }>()

  const { data: order, isLoading, error } = useQuery({
    queryKey: ["order", orderId],
    queryFn: async () => api<OrderDetail>(`/orders/${orderId}`),
    // Confirmation can also arrive through the webhook, so a settling order is
    // polled briefly rather than left looking stuck.
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === "confirmed" || status === "refunded_seat_lost" || status === "failed" ? false : 3000
    },
  })
  const { data: event } = useEvent(order?.eventId ?? "")

  if (error instanceof ApiError) {
    return (
      <Alert variant="destructive" className="mx-auto max-w-lg">
        <AlertTitle>{error.message}</AlertTitle>
        <AlertDescription>
          <span className="font-mono text-xs">{error.requestId}</span>
        </AlertDescription>
      </Alert>
    )
  }
  if (isLoading || order === undefined) {
    return <Skeleton className="mx-auto h-96 w-full max-w-2xl rounded-xl" />
  }

  const confirmed = order.status === "confirmed"
  const compensated = order.status === "refunded_seat_lost" || order.status === "compensating"

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      {confirmed && <BookingSteps current={3} />}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          {confirmed ? "You're going!" : compensated ? "Seat lost" : "Your order"}
        </h1>
        <Badge variant={confirmed ? "default" : compensated ? "destructive" : "secondary"}>
          {LABELS[order.status]}
        </Badge>
      </div>

      {/*
        PRD §10.4 — the compensation path, said plainly. The buyer paid and did not
        get the seat. They are owed a clear statement that their money was released,
        not a generic failure: the authorization was voided, so nothing was charged.
      */}
      {compensated && (
        <Alert variant="destructive">
          <CircleAlertIcon className="size-4" />
          <AlertTitle>Your seat was taken before we could confirm it</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>
              Your payment was released — you have not been charged. This happens when a hold
              expires in the moments between paying and confirming.
            </span>
            {order.failureReason !== null && <span className="font-mono text-xs">{order.failureReason}</span>}
            <Button size="sm" variant="outline" className="mt-1 w-fit" asChild>
              <Link href={`/events/${order.eventId}/seats`}>Find other seats</Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!confirmed && !compensated && (
        <Alert>
          <ClockIcon className="size-4" />
          <AlertTitle>Settling</AlertTitle>
          <AlertDescription>
            Confirming your seats with the payment provider. This page updates itself.
          </AlertDescription>
        </Alert>
      )}

      {/* ── the ticket ─────────────────────────────────────────────────── */}
      <Card className="overflow-hidden p-0">
        <div className="relative h-36">
          {event !== undefined ? (
            <EventPoster event={event} className="absolute inset-0" />
          ) : (
            <Skeleton className="absolute inset-0 rounded-none" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
          <div className="relative flex h-full flex-col justify-end p-5 text-white">
            <h2 className="text-xl font-bold">{event?.title ?? "…"}</h2>
            {event !== undefined && (
              <p className="flex flex-wrap items-center gap-x-3 text-sm text-white/85">
                <span className="flex items-center gap-1">
                  <CalendarIcon className="size-3.5" />
                  {formatEventDate(event.starts_at)}
                </span>
                <span className="flex items-center gap-1">
                  <MapPinIcon className="size-3.5" />
                  Venue on the event page
                </span>
              </p>
            )}
          </div>
        </div>

        <CardContent className="flex flex-col gap-4 p-5">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Seats</p>
              <p className="font-medium tabular-nums">{order.seatIds.length}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Paid</p>
              <p className="font-medium tabular-nums">{formatPaise(order.amountPaise)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Order</p>
              <p className="truncate font-mono text-xs">{order.orderId.slice(0, 8)}</p>
            </div>
          </div>

          {confirmed && (
            <>
              <div className="relative">
                <Separator className="border-dashed" />
                <span className="absolute top-1/2 -left-7 size-5 -translate-y-1/2 rounded-full bg-background" />
                <span className="absolute top-1/2 -right-7 size-5 -translate-y-1/2 rounded-full bg-background" />
              </div>

              <Alert className="border-emerald-500/40 bg-emerald-500/5">
                <CheckCircle2Icon className="size-4 text-emerald-500" />
                <AlertTitle>Show a code at the gate</AlertTitle>
                <AlertDescription>One code per seat. Each admits exactly once.</AlertDescription>
              </Alert>

              <div className="grid gap-4 sm:grid-cols-2">
                {order.tickets.map((ticket, index) => (
                  <div key={ticket.ticket_id} className="flex flex-col items-center gap-2 rounded-lg border p-4">
                    <p className="text-xs font-medium text-muted-foreground">Ticket {index + 1}</p>
                    <div className="rounded-md bg-white p-2">
                      <QRCode value={ticket.qr_token} size={128} />
                    </div>
                    <p className="font-mono text-[10px] text-muted-foreground">{ticket.seat_id.slice(0, 13)}…</p>
                    {ticket.scanned_at !== null && <Badge variant="secondary">Scanned</Badge>}
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {confirmed && (
        <div className="flex flex-wrap gap-2 print:hidden">
          <Button
            variant="outline"
            size="sm"
            disabled={event === undefined}
            onClick={() =>
              event !== undefined &&
              downloadIcs({ title: event.title, startsAt: event.starts_at, location: "See the event page", url: window.location.href, uid: order.orderId })
            }
          >
            <CalendarPlusIcon className="size-4" />
            Add to calendar
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <PrinterIcon className="size-4" />
            Download / print
          </Button>
          <ShareButton title={event?.title ?? "My ticket"} text="My tickets" />
        </div>
      )}
      <Button variant="outline" className="print:hidden" asChild>
        <Link href="/">Browse more events</Link>
      </Button>
    </div>
  )
}
