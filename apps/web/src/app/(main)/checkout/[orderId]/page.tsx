"use client"

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { ShieldCheckIcon, LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { api, ApiError } from "@/lib/api"
import { useSession } from "@/lib/auth"
import { formatPaise } from "@/lib/format"
import { loadRazorpay, openRazorpay, type RazorpayHandlerResponse } from "@/lib/razorpay"
import type { OrderDetail } from "@/lib/api-types"

/**
 * PRD §10.1 — the Razorpay handoff.
 *
 * The order was created with `payment_capture: 0` (ADR-007), so Checkout only
 * ever *authorizes*. Nothing is captured until the seat is provably ours, and if
 * the seat was lost in between the authorization is voided rather than refunded
 * — no money moves at all.
 *
 * The success callback from the browser is not evidence of anything. It is an
 * assertion by an untrusted party, so it is posted to `/orders/:id/verify` where
 * the signature is checked with a secret this page does not have (§10.1.7).
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

  React.useEffect(() => {
    if (order === undefined) return
    if (order.status === "confirmed" || order.status === "refunded_seat_lost") {
      router.replace(`/orders/${orderId}`)
    }
  }, [order, orderId, router])

  const startPayment = async (): Promise<void> => {
    if (order === undefined) return
    setPaying(true)
    try {
      await loadRazorpay()

      /*
       * No second POST /orders.
       *
       * The earlier version re-placed the order to recover the Razorpay handles,
       * which collides with `orders_one_live_per_hold` and dead-ends the buyer on
       * a 409 while their seats stay held. `GET /orders/:id` now carries both
       * handles, so a reloaded checkout resumes the order it already has instead
       * of asking for another one.
       */
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
        description: `${order.seatIds.length} seat${order.seatIds.length === 1 ? "" : "s"}`,
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
              router.push(`/orders/${orderId}`)
            } catch (verifyError) {
              // A 410 here is the compensation path: paid, but the seat was
              // lost. The order page explains it properly.
              if (verifyError instanceof ApiError) {
                toast.error(verifyError.message, { description: verifyError.requestId })
              }
              router.push(`/orders/${orderId}`)
            }
          })()
        },
        modal: { ondismiss: () => setPaying(false) },
      })
    } catch (startError) {
      toast.error(
        startError instanceof ApiError ? startError.message : "Could not start the payment"
      )
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

  if (isLoading || order === undefined) {
    return <Skeleton className="mx-auto h-72 w-full max-w-md rounded-xl" />
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Checkout</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order summary</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Seats</span>
            <span className="tabular-nums">{order.seatIds.length}</span>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Total</span>
            <span className="text-xl font-semibold tabular-nums">
              {formatPaise(order.amountPaise)}
            </span>
          </div>

          <Alert>
            <ShieldCheckIcon className="size-4" />
            <AlertTitle>Authorized now, charged only when the seat is yours</AlertTitle>
            <AlertDescription>
              If the seat is lost between paying and confirming, the authorization is
              released instead of refunded — no money ever moves.
            </AlertDescription>
          </Alert>

          <Button size="lg" onClick={() => void startPayment()} disabled={paying}>
            {paying && <LoaderCircleIcon className="size-4 animate-spin" />}
            Pay {formatPaise(order.amountPaise)}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
