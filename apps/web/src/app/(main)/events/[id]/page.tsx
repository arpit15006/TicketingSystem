"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeftIcon, CalendarIcon, ArmchairIcon, UsersIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ApiError } from "@/lib/api"
import { useAvailability, useEvent } from "@/lib/queries"
import { formatEventDate, formatPaise } from "@/lib/format"

export default function EventDetailPage() {
  const params = useParams<{ id: string }>()
  const eventId = params.id

  const { data: event, isLoading, error } = useEvent(eventId)
  // Live, from reservation — catalog never reports seat state (ADR-006).
  const { data: availability } = useAvailability(eventId, { limit: 5000 })

  if (error instanceof ApiError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{error.message}</AlertTitle>
        <AlertDescription>
          <span className="font-mono text-xs">{error.requestId}</span>
        </AlertDescription>
      </Alert>
    )
  }

  if (isLoading || event === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    )
  }

  const onsale = event.status === "onsale"
  const seatsLeft = availability?.available

  return (
    <div className="flex flex-col gap-8">
      <Button variant="ghost" size="sm" className="self-start px-0" asChild>
        <Link href="/">
          <ArrowLeftIcon className="size-4" />
          All events
        </Link>
      </Button>

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{event.title}</h1>
          <Badge variant={onsale ? "default" : "secondary"}>
            {onsale ? "On sale" : event.status}
          </Badge>
          {event.waiting_room_enabled && (
            <Badge variant="outline" className="gap-1">
              <UsersIcon className="size-3" />
              Waiting room
            </Badge>
          )}
        </div>

        <p className="flex items-center gap-2 text-muted-foreground">
          <CalendarIcon className="size-4" />
          {formatEventDate(event.starts_at)}
        </p>

        {event.description !== "" && (
          <p className="max-w-2xl text-muted-foreground">{event.description}</p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Pricing</CardTitle>
          </CardHeader>
          <CardContent>
            {event.tiers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No pricing tiers yet. This event cannot be published until it has one.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tier</TableHead>
                    <TableHead>Sections</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {event.tiers.map((tier) => {
                    const sections = event.sections.filter((s) => s.tier_id === tier.tier_id)
                    return (
                      <TableRow key={tier.tier_id}>
                        <TableCell className="font-medium">{tier.name}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {sections.length === 0
                            ? "—"
                            : sections.map((s) => s.name).join(", ")}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatPaise(tier.price_paise)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ArmchairIcon className="size-4" />
              Availability
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {seatsLeft === undefined ? (
              <Skeleton className="h-9 w-24" />
            ) : (
              <div>
                <p className="text-3xl font-semibold tabular-nums">{seatsLeft.toLocaleString("en-IN")}</p>
                <p className="text-sm text-muted-foreground">seats free right now</p>
              </div>
            )}

            <Separator />

            <p className="text-sm text-muted-foreground">
              Seats are held for {Math.round(event.hold_duration_seconds / 60)} minutes while you
              pay. An expired hold returns to sale immediately.
            </p>

            <Button size="lg" disabled={!onsale} asChild={onsale}>
              {onsale ? (
                <Link
                  href={
                    event.waiting_room_enabled
                      ? `/events/${eventId}/queue`
                      : `/events/${eventId}/seats`
                  }
                >
                  {event.waiting_room_enabled ? "Join the queue" : "Choose seats"}
                </Link>
              ) : (
                <span>Not yet on sale</span>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
