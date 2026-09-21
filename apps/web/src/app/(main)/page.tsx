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
import { CATEGORY_LABEL, categoryOf, type Category } from "@/lib/poster"
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
 * contradiction — issue #5 is that booking should be the most prominent thing on
 * a card, and the hero's version must not undercut it. White rather than a theme
 * token because the backdrop is an arbitrary gradient.
 */
const ON_MEDIA_PRIMARY = "bg-white text-neutral-900 hover:bg-white/90"

/** A rail is a way through *many* items; below this it is just a short row. */
const MIN_RAIL_ITEMS = 3

export default function HomePage() {
  const { data, isLoading, error } = useEvents()
  const [category, setCategory] = React.useState<Category | "all">("all")
  const [city] = useCity()

  const events = React.useMemo(
    () =>
      (data ?? []).filter(
        (e) =>
          (category === "all" || categoryOf(e.title) === category) &&
          (city === ALL_CITIES || e.venue_city === city)
      ),
    [data, category, city]
  )

  const featured = React.useMemo(
    () => (data ?? []).filter((e) => e.status === "onsale" && (city === ALL_CITIES || e.venue_city === city)).slice(0, 5),
    [data, city]
  )

  // Rails. "This week" is date arithmetic; "High demand" is the events that
  // actually have a waiting room — both facts, neither a guess at popularity.
  // `now` is captured once at mount: reading the clock during render is impure,
  // and a listing does not need to re-bucket itself by the second.
  const [now] = React.useState(() => Date.now())
  const inCity = React.useCallback((e: EventSummary) => city === ALL_CITIES || e.venue_city === city, [city])
  const thisWeek = React.useMemo(() => {
    const week = now + 7 * 86_400_000
    return (data ?? []).filter((e) => {
      const starts = new Date(e.starts_at).getTime()
      return inCity(e) && e.status === "onsale" && starts >= now && starts <= week
    })
  }, [data, inCity, now])
  const highDemand = React.useMemo(
    () => (data ?? []).filter((e) => inCity(e) && e.waiting_room_enabled && e.status === "onsale"),
    [data, inCity]
  )

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

      {/* ── rails ────────────────────────────────────────────────────────── */}
      {!isLoading && category === "all" && thisWeek.length >= MIN_RAIL_ITEMS && (
        <Rail icon={<CalendarDaysIcon />} title="This week" subtitle="Starting in the next seven days" events={thisWeek} />
      )}
      {!isLoading && category === "all" && highDemand.length >= MIN_RAIL_ITEMS && (
        <Rail icon={<FlameIcon />} title="High demand" subtitle="Waiting room in effect — join early" events={highDemand} />
      )}

      {/* ── filters ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            What&apos;s on{city === ALL_CITIES ? "" : ` in ${city}`}
          </h2>
          <p className="text-sm text-muted-foreground">
            {events.length} event{events.length === 1 ? "" : "s"} · seats held while you pay, never oversold.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <CategoryChip active={category === "all"} onClick={() => setCategory("all")}>
            All
          </CategoryChip>
          {CATEGORIES.map((c) => (
            <CategoryChip key={c} active={category === c} onClick={() => setCategory(c)}>
              {CATEGORY_LABEL[c]}
            </CategoryChip>
          ))}
        </div>
      </div>

      {/* ── grid ─────────────────────────────────────────────────────────── */}
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

      {isLoading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
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
              {data?.length === 0 ? "No published events. Run pnpm seed." : "Try another city or category."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {events.map((event) => (
            <EventCard key={event.event_id} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}

function Rail({ icon, title, subtitle, events }: { icon: React.ReactNode; title: string; subtitle: string; events: EventSummary[] }) {
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
      </div>
      <div className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 [scrollbar-width:thin]">
        {events.map((e) => (
          <div key={e.event_id} className="w-64 shrink-0 snap-start">
            <EventCard event={e} />
          </div>
        ))}
      </div>
    </section>
  )
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  /*
   * The shared Button, not a bespoke one. Hand-rolled chips were two more button
   * styles on a page that already had enough, and — worse — they announced no
   * state at all: `aria-pressed` is what tells a screen reader which filter is on.
   */
  return (
    <Button type="button" variant={active ? "default" : "outline"} size="sm" aria-pressed={active} onClick={onClick}>
      {children}
    </Button>
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
          {event.min_price_paise !== null && ` · from ${formatPaise(event.min_price_paise)}`}
        </p>
        {/* One booking verb across the site: the cards say "Book now" too. */}
        <Button size="lg" className={`w-fit ${ON_MEDIA_PRIMARY}`} asChild>
          <Link href={`/events/${event.event_id}`}>
            Book now
            <ArrowRightIcon className="size-4" aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  )
}
