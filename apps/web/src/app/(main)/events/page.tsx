import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { EventsBrowser } from "./events-browser"

/**
 * The browser reads `?category=` and `?when=` with `useSearchParams`, which forces
 * a client-side bailout. Keeping the boundary here means the page still prerenders
 * its shell instead of the whole route opting out of static generation — the same
 * reason the login page has one.
 */
export default function EventsPage() {
  return (
    <Suspense fallback={<EventsSkeleton />}>
      <EventsBrowser />
    </Suspense>
  )
}

function EventsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-24 rounded-lg" />
          ))}
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-20 rounded-lg" />
          ))}
        </div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="aspect-[3/4] rounded-xl" />
        ))}
      </div>
    </div>
  )
}
