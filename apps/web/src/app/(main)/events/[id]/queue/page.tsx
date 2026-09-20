"use client"

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import { UsersIcon, TriangleAlertIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { api, streamSse } from "@/lib/api"
import { useEvent } from "@/lib/queries"
import { useSession } from "@/lib/auth"
import type { QueueStatus } from "@/lib/api-types"

/**
 * PRD §12 / ADR-016 — the waiting room.
 *
 * Two properties are worth showing the user rather than hiding:
 *
 *  - **It fails open.** If Redis is unreachable the service admits everyone and
 *    says `degraded: true`. Seat allocation stays exactly correct either way,
 *    because Redis holds no correctness state (INV-7). The banner below says so.
 *  - **The admission token is the ticket through the gateway**, not a promise
 *    about a seat. Being admitted means you may *try*; it never reserves
 *    anything.
 */
export default function QueuePage() {
  const { id: eventId } = useParams<{ id: string }>()
  const router = useRouter()
  const { data: event } = useEvent(eventId)
  const { isAuthenticated, isLoading: sessionLoading } = useSession()

  const [status, setStatus] = React.useState<QueueStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [joined, setJoined] = React.useState(false)

  React.useEffect(() => {
    if (!isAuthenticated) return
    let stop: (() => void) | undefined
    let cancelled = false

    const run = async (): Promise<void> => {
      const first = await api<QueueStatus>(`/queue/${eventId}/join`, { method: "POST" })
      if (cancelled) return
      setStatus(first)
      setJoined(true)

      if (first.admitted && first.admissionToken !== undefined) {
        sessionStorage.setItem(`ticketing.admission.${eventId}`, first.admissionToken)
        router.replace(`/events/${eventId}/seats`)
        return
      }

      stop = streamSse(`/queue/${eventId}/position`, {
        onEvent: (name, data) => {
          if (name === "position") {
            setStatus((prev) => ({ ...(prev as QueueStatus), ...(data as object) }) as QueueStatus)
          } else if (name === "admitted") {
            const payload = data as { admissionToken?: string }
            if (payload.admissionToken !== undefined) {
              sessionStorage.setItem(`ticketing.admission.${eventId}`, payload.admissionToken)
            }
            router.replace(`/events/${eventId}/seats`)
          }
        },
        onError: () => setError("Lost the connection to the queue. Reload to rejoin."),
      })
    }

    void run().catch(() => setError("Could not join the queue."))

    return () => {
      cancelled = true
      stop?.()
    }
  }, [eventId, isAuthenticated, router])

  if (!sessionLoading && !isAuthenticated) {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>Sign in to join the queue</CardTitle>
        </CardHeader>
        <CardContent>
          <Button onClick={() => router.push(`/login?next=/events/${eventId}/queue`)}>
            Sign in
          </Button>
        </CardContent>
      </Card>
    )
  }

  const ahead = status?.position ?? 0
  const total = status?.total ?? 0
  const progress = total > 0 ? ((total - ahead) / total) * 100 : 0

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{event?.title ?? "Waiting room"}</h1>
        <p className="text-muted-foreground">Hold tight — we let people through in batches.</p>
      </div>

      {status?.degraded === true && (
        <Alert>
          <TriangleAlertIcon className="size-4" />
          <AlertTitle>Queue running in degraded mode</AlertTitle>
          <AlertDescription>
            The queue&apos;s cache is unavailable, so everyone is being let straight through.
            Seat allocation is unaffected — the queue shapes traffic, it never decides who
            gets a seat.
          </AlertDescription>
        </Alert>
      )}

      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UsersIcon className="size-4" />
            Your place in line
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {!joined ? (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Spinner /> Joining the queue…
            </div>
          ) : (
            <>
              <div className="text-center">
                <p className="text-5xl font-semibold tabular-nums">{ahead.toLocaleString("en-IN")}</p>
                <p className="text-sm text-muted-foreground">people ahead of you</p>
              </div>

              <Progress value={progress} />

              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  <Badge variant="secondary">{total.toLocaleString("en-IN")}</Badge> waiting
                </span>
                <span>
                  about {Math.ceil((status?.estimatedWaitSeconds ?? 0) / 60)} min
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground">
        Being admitted means you may try for a seat. It does not reserve one.
      </p>
    </div>
  )
}
