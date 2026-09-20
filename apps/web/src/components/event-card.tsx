import Link from "next/link"
import { CalendarIcon, UsersIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { formatEventDate } from "@/lib/format"
import type { EventSummary } from "@/lib/api-types"

export function EventCard({ event }: { event: EventSummary }) {
  const onsale = event.status === "onsale"

  return (
    <Card className="transition-colors hover:border-foreground/20">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base leading-snug">
            <Link href={`/events/${event.event_id}`} className="after:absolute after:inset-0">
              {event.title}
            </Link>
          </CardTitle>
          <Badge variant={onsale ? "default" : "secondary"}>
            {onsale ? "On sale" : event.status}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <CalendarIcon className="size-4 shrink-0" />
          {formatEventDate(event.starts_at)}
        </span>
        {event.waiting_room_enabled && (
          <span className="flex items-center gap-2">
            <UsersIcon className="size-4 shrink-0" />
            Waiting room enabled
          </span>
        )}
      </CardContent>

      <CardFooter className="text-sm text-muted-foreground">
        {onsale ? "Seats available now" : "Not yet on sale"}
      </CardFooter>
    </Card>
  )
}
