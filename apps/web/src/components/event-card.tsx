import Link from "next/link"
import { MapPinIcon, UsersIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { formatCardDateTime, formatPaise } from "@/lib/format"
import { CATEGORY_LABEL, categoryOf, monogram, posterGradient } from "@/lib/poster"
import type { EventSummary } from "@/lib/api-types"
import { cn } from "cn"

export function EventPoster({
  event,
  className,
}: {
  event: Pick<EventSummary, "event_id" | "title">
  className?: string
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex items-end overflow-hidden text-white",
        posterGradient(event.event_id, event.title),
        className
      )}
    >
      <span className="absolute -top-6 -right-4 text-[7rem] leading-none font-black tracking-tighter text-white/10 select-none">
        {monogram(event.title)}
      </span>
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
    </div>
  )
}

/**
 * The listing card, laid out the way a ticketing storefront does it: a portrait
 * poster, then **date first**, then title, venue, price and a booking CTA.
 *
 * Date leads because that is the field a buyer filters on mentally — "what is on
 * this Saturday" — and it is the one piece of the card that the title can never
 * imply. The poster is 3:4 rather than landscape because cover art for events is
 * produced portrait, and a portrait card fits more of the grid above the fold.
 */
export function EventCard({ event }: { event: EventSummary }) {
  const onsale = event.status === "onsale"
  const category = categoryOf(event.title)

  return (
    <Link
      href={`/events/${event.event_id}`}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card transition-all hover:-translate-y-0.5 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="relative">
        <EventPoster event={event} className="aspect-[3/4] w-full" />
        <div className="absolute top-3 left-3 flex flex-wrap gap-2">
          <Badge className="bg-black/50 text-white backdrop-blur hover:bg-black/50">
            {CATEGORY_LABEL[category]}
          </Badge>
          {event.waiting_room_enabled && (
            <Badge className="gap-1 bg-black/50 text-white backdrop-blur hover:bg-black/50">
              <UsersIcon className="size-3" />
              Queue
            </Badge>
          )}
        </div>
        {!onsale && (
          <Badge variant="secondary" className="absolute top-3 right-3">
            Coming soon
          </Badge>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {formatCardDateTime(event.starts_at)}
        </p>
        <h3 className="line-clamp-2 leading-snug font-semibold group-hover:underline">
          {event.title}
        </h3>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <MapPinIcon className="size-3.5 shrink-0" />
          <span className="truncate">
            {event.venue_name}, {event.venue_city}
          </span>
        </p>

        <div className="mt-auto flex flex-col gap-2.5 pt-3">
          {event.min_price_paise !== null ? (
            <span className="text-sm">
              <span className="font-semibold tabular-nums">{formatPaise(event.min_price_paise)}</span>
              <span className="text-muted-foreground"> onwards</span>
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">Pricing soon</span>
          )}
          {/*
            The card's primary action, given the weight and full width of one —
            but still a <span>. The whole card is already the link; nesting a
            button or a second anchor inside it would put an interactive element
            inside an interactive element, which is invalid and gives keyboard and
            screen reader users two targets for one destination.
          */}
          <span
            className={cn(
              "flex h-9 items-center justify-center rounded-lg text-sm font-semibold transition-colors",
              onsale
                ? "bg-primary text-primary-foreground group-hover:bg-primary/90"
                : "bg-muted text-muted-foreground"
            )}
          >
            {onsale ? "Book tickets" : "View details"}
          </span>
        </div>
      </div>
    </Link>
  )
}
