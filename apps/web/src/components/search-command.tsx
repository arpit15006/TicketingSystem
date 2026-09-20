"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { SearchIcon, CalendarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { useEvents } from "@/lib/queries"
import { formatShortDate } from "@/lib/format"
import { CATEGORY_LABEL, categoryOf } from "@/lib/poster"

/** ⌘K search over everything on sale. */
export function SearchCommand() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()
  const { data: events } = useEvents()

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const grouped = React.useMemo(() => {
    const map = new Map<string, NonNullable<typeof events>>()
    for (const event of events ?? []) {
      const key = CATEGORY_LABEL[categoryOf(event.title)]
      map.set(key, [...(map.get(key) ?? []), event])
    }
    return [...map.entries()]
  }, [events])

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="hidden w-56 justify-between text-muted-foreground md:flex"
        onClick={() => setOpen(true)}
      >
        <span className="flex items-center gap-2">
          <SearchIcon className="size-3.5" />
          Search events
        </span>
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </Button>
      <Button variant="ghost" size="icon" className="md:hidden" aria-label="Search" onClick={() => setOpen(true)}>
        <SearchIcon className="size-4" />
      </Button>

      <CommandDialog open={open} onOpenChange={setOpen} title="Search events" description="Find an event by name">
        <CommandInput placeholder="Search events, artists, venues…" />
        <CommandList>
          <CommandEmpty>No events match.</CommandEmpty>
          {grouped.map(([category, list]) => (
            <CommandGroup key={category} heading={category}>
              {list.map((event) => (
                <CommandItem
                  key={event.event_id}
                  value={`${event.title} ${event.venue_name} ${event.venue_city}`}
                  onSelect={() => {
                    setOpen(false)
                    router.push(`/events/${event.event_id}`)
                  }}
                >
                  <CalendarIcon className="size-4 text-muted-foreground" />
                  <span className="flex flex-col">
                    <span>{event.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatShortDate(event.starts_at)} · {event.venue_city}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </>
  )
}
