"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { ArmchairIcon, TicketIcon, TrendingUpIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { api, ApiError } from "@/lib/api"
import { useSession } from "@/lib/auth"
import { useEvents } from "@/lib/queries"
import { formatEventDate } from "@/lib/format"
import type { EventSummary, SalesSummary } from "@/lib/api-types"

/**
 * PRD §13 — the organizer dashboard.
 *
 * Sales come from reservation's `/inventory/:id/sales`, which is authorized by
 * an explicit `organizer:event:<id>` grant. A 403 here is therefore normal and
 * informative rather than an error: it means this account does not organize that
 * event. The card says so instead of showing a broken number.
 */
function SalesCard({ event }: { event: EventSummary }) {
  const { data, error, isLoading } = useQuery<SalesSummary>({
    queryKey: ["sales", event.event_id],
    queryFn: async () => api<SalesSummary>(`/inventory/${event.event_id}/sales`),
    refetchInterval: 5000,
    retry: false,
  })

  const forbidden = error instanceof ApiError && error.status === 403
  const missing = error instanceof ApiError && error.status === 404

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base leading-snug">
            <Link href={`/events/${event.event_id}`} className="hover:underline">
              {event.title}
            </Link>
          </CardTitle>
          <Badge variant={event.status === "onsale" ? "default" : "secondary"}>
            {event.status}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">{formatEventDate(event.starts_at)}</p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : forbidden ? (
          <p className="text-sm text-muted-foreground">
            You don&apos;t organize this event, so its sales are not yours to see.
          </p>
        ) : missing ? (
          <p className="text-sm text-muted-foreground">No seat inventory provisioned yet.</p>
        ) : data === undefined ? null : (
          <>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-2xl font-semibold tabular-nums">{data.sold.toLocaleString("en-IN")}</p>
                <p className="text-xs text-muted-foreground">sold</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{data.held.toLocaleString("en-IN")}</p>
                <p className="text-xs text-muted-foreground">held</p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">{data.available.toLocaleString("en-IN")}</p>
                <p className="text-xs text-muted-foreground">available</p>
              </div>
            </div>

            <Progress value={data.total === 0 ? 0 : (data.sold / data.total) * 100} />

            <p className="text-xs text-muted-foreground">
              {data.total.toLocaleString("en-IN")} seats total. An expired hold counts as
              available here, exactly as a buyer would find it.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export default function OrganizerPage() {
  const { isAuthenticated, isLoading: sessionLoading } = useSession()
  const { data: events, isLoading } = useEvents()

  if (!sessionLoading && !isAuthenticated) {
    return (
      <Alert className="mx-auto max-w-md">
        <AlertTitle>Sign in required</AlertTitle>
        <AlertDescription>
          <Button size="sm" className="mt-2" asChild>
            <Link href="/login?next=/organizer">Sign in</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
          <TrendingUpIcon className="size-7" />
          Live sales
        </h1>
        <p className="text-muted-foreground">
          Counts come from the service that owns the seats, not from a cache.
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      ) : (events?.length ?? 0) === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ArmchairIcon />
            </EmptyMedia>
            <EmptyTitle>No events</EmptyTitle>
            <EmptyDescription>Run pnpm seed to create a demo event.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(events ?? []).map((event) => (
            <SalesCard key={event.event_id} event={event} />
          ))}
        </div>
      )}

      <Alert>
        <TicketIcon className="size-4" />
        <AlertTitle>Seeing “not yours to see”?</AlertTitle>
        <AlertDescription>
          Sales need an <code className="font-mono text-xs">organizer:event:&lt;id&gt;</code> grant.
          Reservation has no idea who owns an event — that fact lives in catalog — so it asks
          for a grant that names the event rather than guessing.
        </AlertDescription>
      </Alert>
    </div>
  )
}
