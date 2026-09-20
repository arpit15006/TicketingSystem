"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import QRCode from "react-qr-code"
import { CheckCircle2Icon, CircleAlertIcon, ClockIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { api, ApiError } from "@/lib/api"
import { formatPaise } from "@/lib/format"
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
    // Confirmation arrives through the webhook, so a settling order is polled
    // briefly rather than left looking stuck.
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === "confirmed" || status === "refunded_seat_lost" || status === "failed"
        ? false
        : 3000
    },
  })

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
    return <Skeleton className="mx-auto h-96 w-full max-w-lg rounded-xl" />
  }

  const confirmed = order.status === "confirmed"
  const compensated = order.status === "refunded_seat_lost" || order.status === "compensating"

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Your order</h1>
        <Badge variant={confirmed ? "default" : compensated ? "destructive" : "secondary"}>
          {LABELS[order.status]}
        </Badge>
      </div>

      {/*
        PRD §10.4 — the compensation path, said plainly.

        The buyer paid and did not get the seat. They are owed a clear statement
        that their money was released, not a generic failure: the authorization
        was voided rather than captured, so nothing was ever charged.
      */}
      {compensated && (
        <Alert variant="destructive">
          <CircleAlertIcon className="size-4" />
          <AlertTitle>Your seat was taken before we could confirm it</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>
              Your payment was released — you have not been charged. This happens when a
              hold expires in the moments between paying and confirming.
            </span>
            {order.failureReason !== null && (
              <span className="font-mono text-xs">{order.failureReason}</span>
            )}
            <Button size="sm" variant="outline" className="mt-1 w-fit" asChild>
              <Link href={`/events/${order.eventId}/seats`}>Find other seats</Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {confirmed && (
        <Alert>
          <CheckCircle2Icon className="size-4" />
          <AlertTitle>You&apos;re in</AlertTitle>
          <AlertDescription>Show the code at the gate.</AlertDescription>
        </Alert>
      )}

      {!confirmed && !compensated && (
        <Alert>
          <ClockIcon className="size-4" />
          <AlertTitle>Settling</AlertTitle>
          <AlertDescription>
            We are confirming your seats with the payment provider. This page updates itself.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Seats</span>
            <span className="tabular-nums">{order.seatIds.length}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Amount</span>
            <span className="tabular-nums">{formatPaise(order.amountPaise)}</span>
          </div>
          <Separator />
          <div className="flex justify-between">
            <span className="text-muted-foreground">Order</span>
            <span className="font-mono text-xs">{order.orderId}</span>
          </div>
        </CardContent>
      </Card>

      {order.tickets.length > 0 && (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">
            {order.tickets.length} ticket{order.tickets.length === 1 ? "" : "s"}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {order.tickets.map((ticket) => (
              <Card key={ticket.ticket_id}>
                <CardContent className="flex flex-col items-center gap-3 pt-6">
                  <div className="rounded-lg bg-white p-3">
                    <QRCode value={ticket.qr_token} size={132} />
                  </div>
                  <p className="font-mono text-[10px] break-all text-muted-foreground">
                    {ticket.seat_id}
                  </p>
                  {ticket.scanned_at !== null && (
                    <Badge variant="secondary">Scanned</Badge>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <Button variant="outline" asChild>
        <Link href="/">Back to events</Link>
      </Button>
    </div>
  )
}
