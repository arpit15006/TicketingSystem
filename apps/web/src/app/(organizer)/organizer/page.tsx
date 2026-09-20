"use client"

import * as React from "react"
import Link from "next/link"
import { CalendarPlusIcon, ArmchairIcon, IndianRupeeIcon, TicketIcon, TrendingUpIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EventRow } from "@/components/organizer/event-row"
import { SalesChart } from "@/components/organizer/sales-chart"
import { useSession } from "@/lib/auth"
import { useMyEvents } from "@/lib/queries"
import type { EventStatus, SalesSummary } from "@/lib/api-types"

export default function OrganizerOverview() {
  const { isAuthenticated } = useSession()
  const { data: events, isLoading } = useMyEvents(isAuthenticated)
  const [filter, setFilter] = React.useState<"all" | EventStatus>("all")
  const [sales, setSales] = React.useState<Record<string, SalesSummary | null>>({})

  const onSales = React.useCallback((id: string, s: SalesSummary | null) => {
    setSales((prev) => (prev[id] === s ? prev : { ...prev, [id]: s }))
  }, [])

  const visible = (events ?? []).filter((e) => filter === "all" || e.status === filter)

  const totals = React.useMemo(() => {
    let sold = 0
    let held = 0
    let total = 0
    for (const s of Object.values(sales)) {
      if (s === null) continue
      sold += s.sold
      held += s.held
      total += s.total
    }
    return { sold, held, total }
  }, [sales])

  const chartData = (events ?? [])
    .filter((e) => sales[e.event_id] != null)
    .map((e) => {
      const s = sales[e.event_id] as SalesSummary
      return { name: e.title.length > 22 ? `${e.title.slice(0, 21)}…` : e.title, sold: s.sold, held: s.held, available: s.available }
    })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Live figures from the service that owns the seats — an expired hold counts as available here,
            exactly as a buyer would find it.
          </p>
        </div>
        <Button asChild>
          <Link href="/organizer/new">
            <CalendarPlusIcon className="size-4" />
            New event
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={<TicketIcon />} label="Events" value={(events?.length ?? 0).toString()} hint={`${(events ?? []).filter((e) => e.status === "onsale").length} on sale`} />
        <Stat icon={<IndianRupeeIcon />} label="Seats sold" value={totals.sold.toLocaleString("en-IN")} hint={`of ${totals.total.toLocaleString("en-IN")}`} />
        <Stat icon={<ArmchairIcon />} label="Held right now" value={totals.held.toLocaleString("en-IN")} hint="live holds, not yet paid" />
        <Stat icon={<TrendingUpIcon />} label="Sell-through" value={totals.total === 0 ? "—" : `${Math.round((totals.sold / totals.total) * 100)}%`} hint="sold ÷ provisioned" />
      </div>

      {chartData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Inventory by event</CardTitle>
            <CardDescription>Refreshes every 5 seconds.</CardDescription>
          </CardHeader>
          <CardContent>
            <SalesChart data={chartData} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base">Your events</CardTitle>
            <CardDescription>Drafts are only visible here.</CardDescription>
          </div>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="onsale">On sale</TabsTrigger>
              <TabsTrigger value="published">Published</TabsTrigger>
              <TabsTrigger value="draft">Drafts</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CalendarPlusIcon />
                </EmptyMedia>
                <EmptyTitle>No events {filter === "all" ? "yet" : "here"}</EmptyTitle>
                <EmptyDescription>Create one and it appears here as a draft.</EmptyDescription>
              </EmptyHeader>
              <Button asChild>
                <Link href="/organizer/new">New event</Link>
              </Button>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sales</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((event) => (
                  <EventRow key={event.event_id} event={event} onSales={onSales} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between pt-6">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <span className="text-muted-foreground [&_svg]:size-5">{icon}</span>
      </CardContent>
    </Card>
  )
}
