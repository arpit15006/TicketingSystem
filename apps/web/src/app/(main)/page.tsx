"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowRightIcon, CalendarDaysIcon, FlameIcon, SparklesIcon, TicketXIcon } from "lucide-react"
import { EventCard, EventPoster } from "@/components/event-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "@/components/ui/carousel"
import { ApiError } from "@/lib/api"
import { useEvents } from "@/lib/queries"
import { formatEventDate, formatPaise } from "@/lib/format"
import { CATEGORY_LABEL, categoryGradient, categoryOf, type Category } from "@/lib/poster"
import { ALL_CITIES, useCity } from "@/lib/city"
import type { EventSummary } from "@/lib/api-types"

const CATEGORIES: Category[] = ["music", "comedy", "sports", "theatre", "festival"]

/**
 * Controls that sit on the hero's photographic gradient.
 *
 * Theme tokens carry no contrast guarantee against an image, so this is the one
 * place the app states colours literally — and it is a constant rather than two
 * inline overrides so the hero's CTA and its carousel arrows read as one family.
 */
const ON_MEDIA = "border-white/30 bg-white/15 text-white backdrop-blur hover:bg-white/25 hover:text-white"

/**
 * The hero's primary action. Solid, because a translucent primary CTA is a
 * contradiction — booking should be the most prominent thing on a card, and the
 * hero's version must not undercut it. White rather than a theme token because
 * the backdrop is an arbitrary gradient.
 */
const ON_MEDIA_PRIMARY = "bg-white text-neutral-900 hover:bg-white/90"

/** A rail is a way through *many* items; below this it is just a short row. */
const MIN_RAIL_ITEMS = 3

/** How many cards the home page shows before handing off to /events. */
const GRID_PREVIEW = 8

/**
 * The home page is a discovery surface, not the listing.
 *
 * Browsing all of the inventory — with date and category filters over it — is
 * `/events`. Here the page leads with a featured banner, then category entry
 * points, then rails cut from facts the data actually carries, and closes with a
 * preview of what is on that links through. Every section is conditional: a rail
 * with two items in it is not a rail, and an empty one is noise.
 */
export default function HomePage() {
  const { data, isLoading, error } = useEvents()
  const [city] = useCity()

  const inCity = React.useCallback(
    (e: EventSummary) => city === ALL_CITIES || e.venue_city === city,
    [city]
  )

  const events = React.useMemo(() => (data ?? []).filter(inCity), [data, inCity])

  const featured = React.useMemo(
    () => events.filter((e) => e.status === "onsale").slice(0, 5),
    [events]
  )

  // Rails. "This week" is date arithmetic; "High demand" is the events that
  // actually have a waiting room — both facts, neither a guess at popularity.
  // `now` is captured once at mount: reading the clock during render is impure,
  // and a listing does not need to re-bucket itself by the second.
  const [now] = React.useState(() => Date.now())
  const thisWeek = React.useMemo(() => {
    const week = now + 7 * 86_400_000
    return events.filter((e) => {
      const starts = new Date(e.starts_at).getTime()
      return e.status === "onsale" && starts >= now && starts <= week
    })
  }, [events, now])
  const highDemand = React.useMemo(
    () => events.filter((e) => e.waiting_room_enabled && e.status === "onsale"),
    [events]
  )

  /**
   * Category rails, biggest first, capped at two.
   *
   * District runs six or more themed rails, but it has the catalogue to fill
   * them. Deriving one rail per category here would leave a page of two-card
   * rows on a seeded database, so only categories that clear MIN_RAIL_ITEMS
   * qualify and only the two deepest are shown — the rest are a click away in
   * the category strip above.
   */
  const categoryRails = React.useMemo(() => {
    const byCategory = new Map<Category, EventSummary[]>()
    for (const event of events) {
      const key = categoryOf(event.title)
      byCategory.set(key, [...(byCategory.get(key) ?? []), event])
    }
    return [...byCategory.entries()]
      .filter(([, list]) => list.length >= MIN_RAIL_ITEMS)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 2)
  }, [events])

  return (
    <div className="flex flex-col gap-10">
      {/*
        The page's own heading. It is visually hidden because the design leads
        with the carousel, but the outline must still start at h1 — without it the
        first heading a screen reader met was a promotional banner, and the
        listing heading below had been promoted to h1 halfway down the page.
      */}
      <h1 className="sr-only">Events{city === ALL_CITIES ? "" : ` in ${city}`}</h1>

      {/* ── hero ─────────────────────────────────────────────────────────── */}
      {isLoading ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : featured.length > 0 ? (
        <section aria-labelledby="featured-heading">
          <h2 id="featured-heading" className="sr-only">
            Featured events
          </h2>
          <Carousel opts={{ loop: true }} className="w-full">
            <CarouselContent>
              {featured.map((event) => (
                <CarouselItem key={event.event_id}>
                  <FeaturedBanner event={event} />
                </CarouselItem>
              ))}
            </CarouselContent>
            {/*
              Anchored as a pair to the banner's bottom-right corner. Vertically
              centred at the left edge — where they were — put the previous arrow
              on top of the banner's own headline and CTA, which sit bottom-left.
            */}
            <div className="pointer-events-none absolute inset-0 z-10 flex items-end justify-end p-4 md:p-6">
              <div className="pointer-events-auto flex gap-2">
                <CarouselPrevious className={`static ${ON_MEDIA}`} />
                <CarouselNext className={`static ${ON_MEDIA}`} />
              </div>
            </div>
          </Carousel>
        </section>
      ) : null}

      {/* ── explore by category ──────────────────────────────────────────── */}
      <section aria-labelledby="explore-heading" className="flex flex-col gap-3">
        <h2 id="explore-heading" className="text-lg font-semibold">
          Explore events
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {CATEGORIES.map((c) => (
            <CategoryTile key={c} category={c} />
          ))}
        </div>
      </section>

      {/* ── rails ────────────────────────────────────────────────────────── */}
      {!isLoading && thisWeek.length >= MIN_RAIL_ITEMS && (
        <Rail icon={<CalendarDaysIcon />} title="This week" subtitle="Starting in the next seven days" events={thisWeek} />
      )}
      {!isLoading && highDemand.length >= MIN_RAIL_ITEMS && (
        <Rail icon={<FlameIcon />} title="High demand" subtitle="Waiting room in effect — join early" events={highDemand} />
      )}
      {!isLoading &&
        categoryRails.map(([category, list]) => (
          <Rail
            key={category}
            title={CATEGORY_LABEL[category]}
            subtitle={`${list.length} on the calendar`}
            href={`/events?category=${category}`}
            events={list}
          />
        ))}

      {/* ── what's on ────────────────────────────────────────────────────── */}
      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>{error instanceof ApiError ? error.message : "Could not load events"}</AlertTitle>
          <AlertDescription>
            {error instanceof ApiError ? (
              <span className="font-mono text-xs">{error.requestId}</span>
            ) : (
              "Is the gateway running on port 3000?"
            )}
          </AlertDescription>
        </Alert>
      )}

      <section aria-labelledby="whats-on-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="whats-on-heading" className="text-2xl font-semibold tracking-tight">
              What&apos;s on{city === ALL_CITIES ? "" : ` in ${city}`}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isLoading
                ? "Loading…"
                : `${events.length} event${events.length === 1 ? "" : "s"} · seats held while you pay, never oversold.`}
            </p>
          </div>
          {events.length > GRID_PREVIEW && (
            <Button variant="outline" size="sm" asChild>
              <Link href="/events">
                See all {events.length}
                <ArrowRightIcon className="size-4" aria-hidden />
              </Link>
            </Button>
          )}
        </div>

        {isLoading ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: GRID_PREVIEW }, (_, i) => (
              <Skeleton key={i} className="aspect-[3/4] rounded-xl" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TicketXIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing here yet</EmptyTitle>
              <EmptyDescription>
                {data?.length === 0 ? "No published events. Run pnpm seed." : "Try another city."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {events.slice(0, GRID_PREVIEW).map((event) => (
              <EventCard key={event.event_id} event={event} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * A category entry point. The gradient is the same function the posters use, so a
 * tile and the cards it leads to share an identity rather than each inventing one.
 */
function CategoryTile({ category }: { category: Category }) {
  return (
    <Link
      href={`/events?category=${category}`}
      className="group relative flex h-24 items-end overflow-hidden rounded-xl p-3 text-white transition-all hover:-translate-y-0.5 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span aria-hidden className={`absolute inset-0 ${categoryGradient(category, category)}`} />
      <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
      <span className="relative font-semibold">{CATEGORY_LABEL[category]}</span>
    </Link>
  )
}

function Rail({
  icon,
  title,
  subtitle,
  href,
  events,
}: {
  icon?: React.ReactNode
  title: string
  subtitle: string
  href?: string
  events: EventSummary[]
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold [&_svg]:size-5">
            {icon}
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {href !== undefined && (
          <Button variant="ghost" size="sm" asChild>
            <Link href={href}>
              See all
              <ArrowRightIcon className="size-4" aria-hidden />
            </Link>
          </Button>
        )}
      </div>
      <div className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 [scrollbar-width:thin]">
        {events.map((e) => (
          <div key={e.event_id} className="w-52 shrink-0 snap-start sm:w-56">
            <EventCard event={e} />
          </div>
        ))}
      </div>
    </section>
  )
}

function FeaturedBanner({ event }: { event: EventSummary }) {
  return (
    <div className="relative h-72 overflow-hidden rounded-xl md:h-80">
      <EventPoster event={event} className="absolute inset-0" />
      <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/40 to-transparent" />
      <div className="relative flex h-full max-w-2xl flex-col justify-end gap-3 p-6 text-white md:p-10">
        <div className="flex gap-2">
          <Badge className="gap-1 bg-white/15 text-white backdrop-blur hover:bg-white/15">
            <SparklesIcon className="size-3" />
            Featured
          </Badge>
          <Badge className="bg-white/15 text-white backdrop-blur hover:bg-white/15">
            {CATEGORY_LABEL[categoryOf(event.title)]}
          </Badge>
        </div>
        <h3 className="text-3xl leading-tight font-bold tracking-tight md:text-4xl">{event.title}</h3>
        <p className="text-sm text-white/80">
          {formatEventDate(event.starts_at)} · {event.venue_name}, {event.venue_city}
          {event.min_price_paise !== null && ` · ${formatPaise(event.min_price_paise)} onwards`}
        </p>
        {/* One booking verb across the site: the cards say "Book tickets" too. */}
        <Button size="lg" className={`w-fit ${ON_MEDIA_PRIMARY}`} asChild>
          <Link href={`/events/${event.event_id}`}>
            Book tickets
            <ArrowRightIcon className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  )
}
