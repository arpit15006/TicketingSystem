"use client"

import * as React from "react"
import { SearchIcon, TicketXIcon } from "lucide-react"
import { EventCard } from "@/components/event-card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ApiError } from "@/lib/api"
import { useEvents } from "@/lib/queries"
import type { EventStatus } from "@/lib/api-types"

type Filter = "all" | Extract<EventStatus, "onsale" | "published">

export default function HomePage() {
  const [filter, setFilter] = React.useState<Filter>("all")
  const [search, setSearch] = React.useState("")

  const { data, isLoading, error } = useEvents(filter === "all" ? undefined : filter)

  const events = React.useMemo(() => {
    const term = search.trim().toLowerCase()
    if (term === "") return data ?? []
    return (data ?? []).filter((event) => event.title.toLowerCase().includes(term))
  }, [data, search])

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">What&apos;s on</h1>
        <p className="text-muted-foreground">
          Pick an event, choose your seats, and hold them while you pay.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search events"
            className="pl-9"
            aria-label="Search events"
          />
        </div>

        <ToggleGroup
          type="single"
          value={filter}
          onValueChange={(value) => {
            if (value !== "") setFilter(value as Filter)
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="onsale">On sale</ToggleGroupItem>
          <ToggleGroupItem value="published">Upcoming</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>{error instanceof ApiError ? error.message : "Could not load events"}</AlertTitle>
          <AlertDescription>
            {error instanceof ApiError ? (
              <span className="font-mono text-xs">{error.requestId}</span>
            ) : (
              <span>Is the gateway running on port 3000?</span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-52 rounded-xl" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TicketXIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing on sale</EmptyTitle>
            <EmptyDescription>
              {search === ""
                ? "No published events yet. Seed one with pnpm seed."
                : `No event matches “${search}”.`}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((event) => (
            <div key={event.event_id} className="relative">
              <EventCard event={event} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
