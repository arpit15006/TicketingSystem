"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import {
  ArmchairIcon,
  CalendarIcon,
  FlaskConicalIcon,
  ClockIcon,
  MapPinIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react"
import { EventCard, EventPoster } from "@/components/event-card"
import { ShareButton } from "@/components/share-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { api, ApiError } from "@/lib/api"
import { useAvailability, useEvent, useEvents } from "@/lib/queries"
import { formatEventDate, formatPaise } from "@/lib/format"
import { CATEGORY_LABEL, categoryOf } from "@/lib/poster"
import type { Venue } from "@/lib/api-types"

export default function EventDetailPage() {
  const { id: eventId } = useParams<{ id: string }>()
  const { data: event, isLoading, error } = useEvent(eventId)
  const { data: availability } = useAvailability(eventId, { limit: 5000 })
  const { data: allEvents } = useEvents()
  const { data: venue } = useQuery({
    queryKey: ["venue", event?.venue_id],
    queryFn: async () => api<Venue>(`/catalog/venues/${event?.venue_id}`),
    enabled: event !== undefined,
    staleTime: 600_000,
  })

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
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    )
  }

  /*
   * The Sections column earns its place only when it says something the Tier
   * column does not. A seatmap where each tier is one identically-named section
   * — Stalls → STALLS — otherwise prints every name twice in different case,
   * which is noise, not information.
   */
  const sectionsFor = (tierId: string) => event.sections.filter((s) => s.tier_id === tierId)
  const showSections = event.tiers.some((tier) => {
    const names = sectionsFor(tier.tier_id).map((s) => s.name)
    return names.length > 1 || (names[0] !== undefined && names[0].toLowerCase() !== tier.name.toLowerCase())
  })

  const onsale = event.status === "onsale"
  const seatsLeft = availability?.available
  const cheapest = event.tiers.length === 0 ? null : Math.min(...event.tiers.map((t) => t.price_paise))
  const bookingHref = event.waiting_room_enabled ? `/events/${eventId}/queue` : `/events/${eventId}/seats`

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-3">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">Events</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{CATEGORY_LABEL[categoryOf(event.title)]}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <ShareButton title={event.title} text={`${event.title} — ${formatEventDate(event.starts_at)}`} />
      </div>

      {/* ── poster band ──────────────────────────────────────────────────── */}
      <div className="relative h-64 overflow-hidden rounded-xl md:h-80">
        <EventPoster event={event} className="absolute inset-0" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
        <div className="relative flex h-full flex-col justify-end gap-3 p-6 text-white md:p-8">
          <div className="flex flex-wrap gap-2">
            <Badge className="bg-white/15 text-white backdrop-blur hover:bg-white/15">
              {CATEGORY_LABEL[categoryOf(event.title)]}
            </Badge>
            <Badge className={onsale ? "bg-emerald-500 text-white hover:bg-emerald-500" : "bg-white/15 text-white hover:bg-white/15"}>
              {onsale ? "On sale" : "Coming soon"}
            </Badge>
            {event.waiting_room_enabled && (
              <Badge className="gap-1 bg-white/15 text-white backdrop-blur hover:bg-white/15">
                <UsersIcon className="size-3" />
                Waiting room
              </Badge>
            )}
          </div>
          <h1 className="text-3xl leading-tight font-bold tracking-tight md:text-4xl">{event.title}</h1>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-white/85">
            <span className="flex items-center gap-1.5">
              <CalendarIcon className="size-4" />
              {formatEventDate(event.starts_at)}
            </span>
            <span className="flex items-center gap-1.5">
              <MapPinIcon className="size-4" />
              {venue?.name ?? "…"}, {venue?.city ?? ""}
            </span>
          </p>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-8">
          {event.description !== "" && (
            <section className="flex flex-col gap-2">
              <h2 className="text-lg font-semibold">About</h2>
              <p className="max-w-2xl leading-relaxed text-muted-foreground">{event.description}</p>
            </section>
          )}

          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Tickets</h2>
            <Card>
              <CardContent className="pt-0">
                {/*
                  The price used to be right-aligned across a full-width table, so
                  it sat ~360px from its own tier and a row had to be tracked
                  across empty space to be read.
                  Sizing the table to its content fixed that but left a small
                  orphaned block in a wide card, with rules that stopped short.
                  Instead the table still spans the card — so the row rules do too
                  — and the price column absorbs the slack with `w-full`. The
                  label columns then hug their content and the price begins
                  immediately after them. `tabular-nums` keeps the figures
                  aligned with each other down the column.
                */}
                {event.tiers.length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">No pricing tiers yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tier</TableHead>
                        {showSections && <TableHead>Sections</TableHead>}
                        <TableHead className="w-full">Price</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {event.tiers.map((tier) => {
                        const sections = sectionsFor(tier.tier_id)
                        return (
                          <TableRow key={tier.tier_id}>
                            <TableCell className="font-medium">{tier.name}</TableCell>
                            {showSections && (
                              <TableCell className="text-muted-foreground">
                                {sections.length === 0 ? "—" : sections.map((s) => s.name).join(", ")}
                              </TableCell>
                            )}
                            <TableCell className="font-medium tabular-nums">
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
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Venue</h2>
            <Item variant="outline">
              <ItemMedia variant="icon">
                <MapPinIcon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{venue?.name ?? <Skeleton className="h-4 w-40" />}</ItemTitle>
                <ItemDescription>
                  {venue !== undefined ? `${venue.address}, ${venue.city}` : ""}
                </ItemDescription>
              </ItemContent>
            </Item>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Good to know</h2>
            <Accordion type="single" collapsible className="rounded-xl border px-4">
              <AccordionItem value="hold">
                <AccordionTrigger>How long are my seats held?</AccordionTrigger>
                <AccordionContent>
                  {Math.round(event.hold_duration_seconds / 60)} minutes from the moment you hold
                  them. When the timer runs out they go back on sale automatically — nothing
                  needs to run for that to happen, so there is never a stale hold.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="payment">
                <AccordionTrigger>When am I charged?</AccordionTrigger>
                <AccordionContent>
                  Your card is authorized at checkout and charged only once the seat is
                  confirmed yours. If the seat is lost in between, the authorization is
                  released — no money moves, and there is nothing to refund.
                </AccordionContent>
              </AccordionItem>
              {event.waiting_room_enabled && (
                <AccordionItem value="queue">
                  <AccordionTrigger>Why is there a queue?</AccordionTrigger>
                  <AccordionContent>
                    Demand for this event is high, so buyers are let through in batches. Being
                    admitted lets you try for seats; it does not reserve any.
                  </AccordionContent>
                </AccordionItem>
              )}
            </Accordion>
          </section>
        </div>

        {/* ── sticky booking card ──────────────────────────────────────── */}
        <div className="lg:sticky lg:top-20 lg:h-fit">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-baseline gap-2">
                {cheapest !== null ? (
                  <>
                    <span className="text-sm font-normal text-muted-foreground">from</span>
                    <span className="text-2xl tabular-nums">{formatPaise(cheapest)}</span>
                  </>
                ) : (
                  <span className="text-lg">Pricing soon</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-3 text-sm">
                <ArmchairIcon className="size-4 text-muted-foreground" />
                {seatsLeft === undefined ? (
                  <Skeleton className="h-4 w-28" />
                ) : (
                  <span>
                    <span className="font-semibold tabular-nums">{seatsLeft.toLocaleString("en-IN")}</span>{" "}
                    <span className="text-muted-foreground">seats free right now</span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <ClockIcon className="size-4" />
                Held {Math.round(event.hold_duration_seconds / 60)} min while you pay
              </div>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <ShieldCheckIcon className="size-4" />
                Charged only once confirmed
              </div>

              <Separator />

              <Button size="lg" className="w-full" disabled={!onsale} asChild={onsale}>
                {onsale ? (
                  <Link href={bookingHref}>
                    {event.waiting_room_enabled ? "Join the queue" : "Choose seats"}
                  </Link>
                ) : (
                  <span>Not yet on sale</span>
                )}
              </Button>
              {!onsale && event.onsale_at !== null && (
                <p className="text-center text-xs text-muted-foreground">
                  On sale {formatEventDate(event.onsale_at)}
                </p>
              )}
              {onsale && (
                <Button variant="outline" size="sm" className="w-full" asChild>
                  <Link href={`/proof?event=${eventId}`}>
                    <FlaskConicalIcon className="size-4" />
                    Test concurrency on this event
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      {/* ── you might also like ─────────────────────────────────────────── */}
      {(() => {
        const category = categoryOf(event.title)
        const similar = (allEvents ?? [])
          .filter((e) => e.event_id !== event.event_id)
          .sort((a, b) => {
            const score = (x: typeof a) => (categoryOf(x.title) === category ? 2 : 0) + (x.venue_city === venue?.city ? 1 : 0)
            return score(b) - score(a)
          })
          .slice(0, 4)
        return similar.length === 0 ? null : (
          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">You might also like</h2>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {similar.map((e) => (
                <EventCard key={e.event_id} event={e} />
              ))}
            </div>
          </section>
        )
      })()}
    </div>
  )
}