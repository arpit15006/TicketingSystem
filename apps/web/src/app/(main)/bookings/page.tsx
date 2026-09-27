"use client"

import * as React from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { CalendarIcon, ChevronRightIcon, MapPinIcon, QrCodeIcon, TicketsIcon } from "lucide-react"
import { EventPoster } from "@/components/event-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { api, ApiError } from "@/lib/api"
import { useSession } from "@/lib/auth"
import { useEvents } from "@/lib/queries"
import { formatEventDate, formatPaise, formatShortDate } from "@/lib/format"
import type { EventSummary, OrderStatus, OrderSummary } from "@/lib/api-types"

const LABEL: Record<OrderStatus, { text: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  confirmed: { text: "Confirmed", variant: "default" },
  awaiting_payment: { text: "Payment pending", variant: "outline" },
  created: { text: "Starting", variant: "outline" },
  payment_authorized: { text: "Confirming", variant: "secondary" },
  compensating: { text: "Releasing payment", variant: "destructive" },
  refunded_seat_lost: { text: "Seat lost — released", variant: "destructive" },
  failed: { text: "Failed", variant: "destructive" },
  cancelled: { text: "Cancelled", variant: "secondary" },
}

export default function BookingsPage() {
  const { isAuthenticated, isLoading: sessionLoading } = useSession()
  const { data: events } = useEvents()
  // Captured once at mount: reading the clock during render is impure. Hooks
  // stay above the sign-in early return.
  const [now] = React.useState(() => Date.now())
  const { data, isLoading, error } = useQuery({
    queryKey: ["orders", "mine"],
    queryFn: async () => (await api<{ orders: OrderSummary[] }>("/orders")).orders,
    enabled: isAuthenticated,
    refetchInterval: 10_000,
  })

  if (!sessionLoading && !isAuthenticated) {
    return (
      <Alert className="mx-auto max-w-md">
        <AlertTitle>Sign in to see your bookings</AlertTitle>
        <AlertDescription>
          <Button size="sm" className="mt-2" asChild>
            <Link href="/login?next=/bookings">Sign in</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  const eventsById = new Map((events ?? []).map((e) => [e.event_id, e]))
  const orders = data ?? []
  const startsAt = (o: OrderSummary): number => new Date(eventsById.get(o.eventId)?.starts_at ?? 0).getTime()
  const confirmedAll = orders.filter((o) => o.status === "confirmed")
  const upcoming = confirmedAll.filter((o) => startsAt(o) >= now)
  const pending = orders.filter((o) => o.status === "awaiting_payment" || o.status === "created" || o.status === "payment_authorized")
  const past = orders.filter((o) => !upcoming.includes(o) && !pending.includes(o))

  return (
    /*
     * Full content width, not max-w-3xl.
     * Header, main and footer all share one container and one centre, so a
     * narrow column is concentric rather than offset — but it still ended 176px
     * inside the footer on each side, which is what read as disjointed. A
     * narrow measure is right for prose and forms (an order, the account page);
     * a list of bookings has no such argument, so it uses the page width the
     * header and footer already use, and pairs up on wide screens.
     */
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <TicketsIcon className="size-6" />
          My bookings
        </h1>
        <p className="text-sm text-muted-foreground">Every ticket has a code that admits exactly once.</p>
      </div>

      {error instanceof ApiError && (
        <Alert variant="destructive">
          <AlertTitle>{error.message}</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-xs">{error.requestId}</span>
          </AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TicketsIcon />
            </EmptyMedia>
            <EmptyTitle>No bookings yet</EmptyTitle>
            <EmptyDescription>When you book, your tickets and QR codes live here.</EmptyDescription>
          </EmptyHeader>
          <Button asChild>
            <Link href="/">Browse events</Link>
          </Button>
        </Empty>
      ) : (
        <Tabs defaultValue={upcoming.length > 0 ? "tickets" : pending.length > 0 ? "pending" : "past"}>
          <TabsList>
            <TabsTrigger value="tickets">Upcoming ({upcoming.length})</TabsTrigger>
            <TabsTrigger value="pending">Pending ({pending.length})</TabsTrigger>
            <TabsTrigger value="past">Past & other ({past.length})</TabsTrigger>
          </TabsList>
          {(
            [
              ["tickets", upcoming, "No upcoming tickets."],
              ["pending", pending, "Nothing waiting on payment."],
              ["past", past, "Nothing here."],
            ] as const
          ).map(([value, list, empty]) => (
            <TabsContent key={value} value={value} className="mt-4 grid gap-4 xl:grid-cols-2">
              {list.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground xl:col-span-2">{empty}</p>
              ) : (
                list.map((order) => <BookingCard key={order.orderId} order={order} event={eventsById.get(order.eventId)} />)
              )}
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  )
}

function BookingCard({ order, event }: { order: OrderSummary; event: EventSummary | undefined }) {
  const label = LABEL[order.status]
  const confirmed = order.status === "confirmed"
  const href = order.status === "awaiting_payment" ? `/checkout/${order.orderId}` : `/orders/${order.orderId}`

  return (
    <Link href={href} className="press-sm group block focus-visible:outline-none">
      <Card className="flex flex-row overflow-hidden p-0 transition-shadow group-hover:shadow-md group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <div className="relative w-28 shrink-0 sm:w-40">
          {event !== undefined ? (
            <EventPoster event={event} className="absolute inset-0" />
          ) : (
            <div className="absolute inset-0 bg-muted" />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
          <div className="flex items-start justify-between gap-3">
            {/* h2, not h3: the page h1 is the only heading above these, so an
                h3 skipped a level. */}
            <h2 className="line-clamp-2 leading-snug font-semibold">{event?.title ?? "Event"}</h2>
            <div className="flex shrink-0 items-center gap-1.5">
              {confirmed && order.scannedCount > 0 && (
                <Badge variant="secondary">
                  {order.scannedCount}/{order.ticketCount} used
                </Badge>
              )}
              <Badge variant={label.variant}>{label.text}</Badge>
            </div>
          </div>

          {event !== undefined && (
            <div className="flex flex-col gap-1 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <CalendarIcon className="size-3.5 shrink-0" />
                {formatEventDate(event.starts_at)}
              </span>
              <span className="flex items-center gap-1.5">
                <MapPinIcon className="size-3.5 shrink-0" />
                <span className="truncate">
                  {event.venue_name}, {event.venue_city}
                </span>
              </span>
            </div>
          )}

          <div className="mt-auto flex items-center justify-between gap-3 pt-1 text-sm">
            <span className="text-muted-foreground">
              {order.seatCount} seat{order.seatCount === 1 ? "" : "s"} · {formatPaise(order.amountPaise)} · booked{" "}
              {formatShortDate(order.createdAt)}
            </span>
            {/*
              The action label always says what the card does. It used to be
              replaced by "1/3 used" once a ticket had been scanned, which hid
              the only signifier that the card opens anything — the status is a
              badge beside it now, where status belongs.
            */}
            <span className="flex shrink-0 items-center gap-1 font-medium text-primary">
              {confirmed ? (
                <>
                  <QrCodeIcon className="size-4" />
                  View QR
                </>
              ) : order.status === "awaiting_payment" ? (
                "Complete payment"
              ) : (
                "Details"
              )}
              <ChevronRightIcon className="size-4" />
            </span>
          </div>
        </div>
      </Card>
    </Link>
  )
}
