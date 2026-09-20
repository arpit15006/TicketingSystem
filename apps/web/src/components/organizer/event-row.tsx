"use client"

import * as React from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { ArmchairIcon, ExternalLinkIcon, MoreHorizontalIcon, RocketIcon, UploadIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { TableCell, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { api, ApiError } from "@/lib/api"
import { pickUpNewGrants } from "@/lib/auth"
import { formatShortDate } from "@/lib/format"
import type { EventDetail, EventSummary, SalesSummary } from "@/lib/api-types"

export function useSales(eventId: string) {
  return useQuery<SalesSummary, ApiError>({
    queryKey: ["sales", eventId],
    queryFn: async () => api<SalesSummary>(`/inventory/${eventId}/sales`),
    refetchInterval: 5000,
    retry: false,
  })
}

export function EventRow({ event, onSales }: { event: EventSummary; onSales: (id: string, s: SalesSummary | null) => void }) {
  const queryClient = useQueryClient()
  const sales = useSales(event.event_id)
  const [confirm, setConfirm] = React.useState<"onsale" | "published" | null>(null)

  React.useEffect(() => {
    onSales(event.event_id, sales.data ?? null)
  }, [sales.data, event.event_id, onSales])

  const noInventory = sales.error?.status === 404
  const forbidden = sales.error?.status === 403

  const publish = useMutation({
    mutationFn: async (onsale: boolean) =>
      api(`/catalog/events/${event.event_id}/publish`, { method: "POST", body: { onsale } }),
    onSuccess: (_d, onsale) => {
      toast.success(onsale ? "On sale" : "Published")
      void queryClient.invalidateQueries({ queryKey: ["events"] })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not publish"),
  })

  const provision = useMutation({
    mutationFn: async () => {
      // The grant that authorizes this was issued when the event was created;
      // make sure the token carries it before asking.
      await pickUpNewGrants()
      const detail = await api<EventDetail>(`/catalog/events/${event.event_id}`)
      if (detail.sections.length === 0) throw new Error("Add at least one section first")
      return api<{ created: number; totalSeats: number }>(`/inventory/${event.event_id}/seats`, {
        method: "POST",
        body: {
          sections: detail.sections.map((s) => ({
            name: s.name,
            tierId: s.tier_id,
            rowCount: s.row_count,
            seatsPerRow: s.seats_per_row,
          })),
        },
      })
    },
    onSuccess: (r) => {
      toast.success(`${r.totalSeats.toLocaleString("en-IN")} seats ready`)
      void queryClient.invalidateQueries({ queryKey: ["sales", event.event_id] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not provision seats"),
  })

  const soldPct = sales.data !== undefined && sales.data.total > 0 ? (sales.data.sold / sales.data.total) * 100 : 0

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <Link href={`/events/${event.event_id}`} className="font-medium hover:underline">
            {event.title}
          </Link>
          <span className="text-xs text-muted-foreground">
            {formatShortDate(event.starts_at)} · {event.venue_name}, {event.venue_city}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={event.status === "onsale" ? "default" : event.status === "draft" ? "outline" : "secondary"}>
          {event.status === "onsale" ? "On sale" : event.status}
        </Badge>
      </TableCell>
      <TableCell className="min-w-44">
        {sales.isLoading ? (
          <Skeleton className="h-4 w-32" />
        ) : noInventory ? (
          <span className="text-xs text-muted-foreground">No seats provisioned</span>
        ) : forbidden ? (
          <span className="text-xs text-muted-foreground">Not your event</span>
        ) : sales.data !== undefined ? (
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs tabular-nums">
              <span>
                <span className="font-medium">{sales.data.sold.toLocaleString("en-IN")}</span>
                <span className="text-muted-foreground"> / {sales.data.total.toLocaleString("en-IN")} sold</span>
              </span>
              <span className="text-muted-foreground">{sales.data.held} held</span>
            </div>
            <Progress value={soldPct} className="h-1.5" />
          </div>
        ) : null}
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Actions">
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>{event.title}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href={`/events/${event.event_id}`}>
                <ExternalLinkIcon className="size-4" />
                View event page
              </Link>
            </DropdownMenuItem>
            {noInventory && event.status !== "draft" && (
              <DropdownMenuItem onSelect={() => provision.mutate()} disabled={provision.isPending}>
                <ArmchairIcon className="size-4" />
                Provision seats
              </DropdownMenuItem>
            )}
            {event.status === "draft" && (
              <DropdownMenuItem onSelect={() => setConfirm("published")}>
                <UploadIcon className="size-4" />
                Publish (not on sale)
              </DropdownMenuItem>
            )}
            {event.status !== "onsale" && (
              <DropdownMenuItem onSelect={() => setConfirm("onsale")}>
                <RocketIcon className="size-4" />
                Put on sale
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm === "onsale" ? "Put this event on sale?" : "Publish this event?"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm === "onsale"
                  ? "Buyers can hold and pay for seats immediately. Make sure seats are provisioned first."
                  : "The event becomes visible on the site as “coming soon”. Nobody can buy yet."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirm !== null) publish.mutate(confirm === "onsale")
                  setConfirm(null)
                }}
              >
                {confirm === "onsale" ? "Put on sale" : "Publish"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  )
}
