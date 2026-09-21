"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { TicketXIcon } from "lucide-react"
import { EventCard } from "@/components/event-card"
import { FilterChip } from "@/components/filter-chip"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ApiError } from "@/lib/api"
import { useEvents } from "@/lib/queries"
import { CATEGORY_LABEL, categoryOf, type Category } from "@/lib/poster"
import { WHEN_LABEL, startsWithin, whenRange, type When } from "@/lib/when"
import { ALL_CITIES, useCity } from "@/lib/city"

const CATEGORIES: Category[] = ["music", "comedy", "sports", "theatre", "festival"]
const WHENS: Exclude<When, "all">[] = ["today", "tomorrow", "weekend"]

function parseCategory(raw: string | null): Category | "all" {
  return CATEGORIES.includes(raw as Category) ? (raw as Category) : "all"
}

function parseWhen(raw: string | null): When {
  return WHENS.includes(raw as Exclude<When, "all">) ? (raw as When) : "all"
}

/**
 * The browse surface: every event, with date and category filters over it.
 *
 * Both filters live in the query string rather than in component state. That is
 * what lets the header's category strip and these chips be one mechanism instead
 * of two that can disagree — and it makes a filtered listing a link somebody can
 * send to a friend.
 */
export function EventsBrowser() {
  const { data, isLoading, error } = useEvents()
  const [city] = useCity()
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const category = parseCategory(params.get("category"))
  const when = parseWhen(params.get("when"))

  // Captured once at mount: reading the clock during render is impure, and a
  // listing does not need to re-bucket itself by the second.
  const [now] = React.useState(() => Date.now())
  const range = React.useMemo(() => whenRange(when, now), [when, now])

  const setParam = React.useCallback(
    (key: string, value: string | null): void => {
      const next = new URLSearchParams(params.toString())
      if (value === null) next.delete(key)
      else next.set(key, value)
      const query = next.toString()
      router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false })
    },
    [params, pathname, router]
  )

  const events = React.useMemo(
    () =>
      (data ?? []).filter(
        (e) =>
          (category === "all" || categoryOf(e.title) === category) &&
          (city === ALL_CITIES || e.venue_city === city) &&
          startsWithin(e.starts_at, range)
      ),
    [data, category, city, range]
  )

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {category === "all" ? "All events" : CATEGORY_LABEL[category]}
          {city === ALL_CITIES ? "" : ` in ${city}`}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isLoading
            ? "Loading…"
            : `${events.length} event${events.length === 1 ? "" : "s"} · seats held while you pay, never oversold.`}
        </p>
      </div>

      {/*
        Two chip rows, date above category, because date is the coarser cut — it
        is the question a buyer answers first. Both scroll rather than wrap so the
        pair stays two lines deep on a phone.
      */}
      <div className="flex flex-col gap-3">
        <div
          role="group"
          aria-label="Filter by date"
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <FilterChip active={when === "all"} onClick={() => setParam("when", null)}>
            Any date
          </FilterChip>
          {WHENS.map((w) => (
            <FilterChip key={w} active={when === w} onClick={() => setParam("when", w)}>
              {WHEN_LABEL[w]}
            </FilterChip>
          ))}
        </div>

        <div
          role="group"
          aria-label="Filter by category"
          className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <FilterChip active={category === "all"} onClick={() => setParam("category", null)}>
            All
          </FilterChip>
          {CATEGORIES.map((c) => (
            <FilterChip key={c} active={category === c} onClick={() => setParam("category", c)}>
              {CATEGORY_LABEL[c]}
            </FilterChip>
          ))}
        </div>
      </div>

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
            <EmptyTitle>Nothing matches</EmptyTitle>
            <EmptyDescription>
              {data?.length === 0
                ? "No published events. Run pnpm seed."
                : "Try another date, category or city."}
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
