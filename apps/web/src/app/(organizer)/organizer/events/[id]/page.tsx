"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useForm, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { ArmchairIcon, ExternalLinkIcon, IndianRupeeIcon, ScanLineIcon, TicketIcon, UsersIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { api, ApiError } from "@/lib/api"
import { useEvent, useSalesSummary } from "@/lib/queries"
import { formatEventDate, formatPaise, formatShortDate } from "@/lib/format"
import type { EventOrderRow, EventSales } from "@/lib/api-types"

const editSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000),
  waitingRoomEnabled: z.boolean(),
})
type EditValues = z.infer<typeof editSchema>

const chartConfig = { revenue: { label: "Revenue (₹)", color: "var(--chart-1)" } } satisfies ChartConfig

export default function OrganizerEventPage() {
  const { id: eventId } = useParams<{ id: string }>()
  const queryClient = useQueryClient()
  const { data: event } = useEvent(eventId)
  const inventory = useSalesSummary(eventId)
  const sales = useQuery<EventSales, ApiError>({
    queryKey: ["event-sales", eventId],
    queryFn: async () => api<EventSales>(`/orders/events/${eventId}/sales`),
    refetchInterval: 10_000,
    retry: false,
  })
  const orders = useQuery<EventOrderRow[], ApiError>({
    queryKey: ["event-orders", eventId],
    queryFn: async () => (await api<{ orders: EventOrderRow[] }>(`/orders/events/${eventId}/orders`)).orders,
    refetchInterval: 15_000,
    retry: false,
  })

  if (sales.error?.status === 403) {
    return (
      <Alert className="max-w-md">
        <AlertTitle>Not your event</AlertTitle>
        <AlertDescription>Only an organizer holding a grant for this event can see its sales.</AlertDescription>
      </Alert>
    )
  }

  const s = sales.data
  const inv = inventory.data
  const chartData = (s?.byDay ?? []).map((d) => ({ day: formatShortDate(d.day), revenue: d.revenuePaise / 100, orders: d.orders }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{event?.title ?? <Skeleton className="h-7 w-64" />}</h1>
            {event !== undefined && (
              <Badge variant={event.status === "onsale" ? "default" : event.status === "draft" ? "outline" : "secondary"}>
                {event.status === "onsale" ? "On sale" : event.status}
              </Badge>
            )}
          </div>
          {event !== undefined && <p className="text-sm text-muted-foreground">{formatEventDate(event.starts_at)}</p>}
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/events/${eventId}`}>
            <ExternalLinkIcon className="size-4" />
            Public page
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={<IndianRupeeIcon />} label="Revenue" value={s === undefined ? null : formatPaise(s.revenuePaise)} hint={`${s?.confirmedOrders ?? 0} confirmed orders`} />
        <Stat icon={<ArmchairIcon />} label="Seats sold" value={inv === undefined ? null : inv.sold.toLocaleString("en-IN")} hint={inv === undefined ? "" : `of ${inv.total.toLocaleString("en-IN")} · ${inv.held} held now`} />
        <Stat icon={<ScanLineIcon />} label="Scanned at gate" value={s === undefined ? null : `${s.ticketsScanned}/${s.ticketsIssued}`} hint="tickets used / issued" />
        <Stat icon={<UsersIcon />} label="Pending · compensated" value={s === undefined ? null : `${s.pendingOrders} · ${s.compensatedOrders}`} hint="awaiting payment · seat lost after paying" />
      </div>

      {inv !== undefined && (
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Sell-through</span>
              <span className="tabular-nums">{inv.total === 0 ? "—" : `${Math.round((inv.sold / inv.total) * 100)}%`}</span>
            </div>
            <Progress value={inv.total === 0 ? 0 : (inv.sold / inv.total) * 100} />
            <p className="text-xs text-muted-foreground">
              Seat counts from reservation, money from orders — two services, never conflated. An expired hold
              counts as available here, exactly as a buyer would find it.
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="sales">
        <TabsList>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="edit">Edit</TabsTrigger>
          <TabsTrigger value="scanners">Scanners</TabsTrigger>
        </TabsList>

        <TabsContent value="sales">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Revenue by day</CardTitle>
              <CardDescription>Confirmed orders only.</CardDescription>
            </CardHeader>
            <CardContent>
              {chartData.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No confirmed orders yet.</p>
              ) : (
                <ChartContainer config={chartConfig} className="h-64 w-full">
                  <BarChart data={chartData}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={60} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="revenue" fill="var(--color-revenue)" radius={4} />
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orders">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Orders</CardTitle>
              <CardDescription>
                Buyers are shown by account id — names live in identity and are not this view&apos;s to hand out.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              {orders.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (orders.data ?? []).length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No orders yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Buyer</TableHead>
                      <TableHead>Seats</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Gate</TableHead>
                      <TableHead>Placed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(orders.data ?? []).map((o) => (
                      <TableRow key={o.orderId}>
                        <TableCell className="font-mono text-xs">{o.orderId.slice(0, 8)}</TableCell>
                        <TableCell className="font-mono text-xs">{o.userId.slice(0, 8)}…</TableCell>
                        <TableCell className="tabular-nums">{o.seatCount}</TableCell>
                        <TableCell className="tabular-nums">{formatPaise(o.amountPaise)}</TableCell>
                        <TableCell>
                          <Badge variant={o.status === "confirmed" ? "default" : o.status === "refunded_seat_lost" ? "destructive" : "secondary"}>
                            {o.status.replace(/_/g, " ")}
                          </Badge>
                        </TableCell>
                        <TableCell className="tabular-nums">{o.ticketCount === 0 ? "—" : `${o.scannedCount}/${o.ticketCount}`}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatShortDate(o.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="edit">
          {event !== undefined && (
            <EditEventForm
              eventId={eventId}
              initial={{ title: event.title, description: event.description, waitingRoomEnabled: event.waiting_room_enabled }}
              onSaved={() => void queryClient.invalidateQueries({ queryKey: ["event", eventId] })}
            />
          )}
        </TabsContent>

        <TabsContent value="scanners">
          <AssignScanner eventId={eventId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string | null; hint: string }) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between pt-6">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          {value === null ? <Skeleton className="my-1 h-7 w-24" /> : <p className="text-2xl font-semibold tabular-nums">{value}</p>}
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <span className="text-muted-foreground [&_svg]:size-5">{icon}</span>
      </CardContent>
    </Card>
  )
}

function EditEventForm({ eventId, initial, onSaved }: { eventId: string; initial: EditValues; onSaved: () => void }) {
  const form = useForm<EditValues>({ resolver: zodResolver(editSchema), defaultValues: initial })
  const save = useMutation({
    mutationFn: async (values: EditValues) =>
      api(`/catalog/events/${eventId}`, {
        method: "PATCH",
        body: { title: values.title, description: values.description, waitingRoomEnabled: values.waitingRoomEnabled },
      }),
    onSuccess: () => {
      toast.success("Saved")
      onSaved()
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not save"),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Edit event</CardTitle>
        <CardDescription>Pricing and the seatmap are fixed once seats are provisioned.</CardDescription>
      </CardHeader>
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
        <CardContent className="flex flex-col gap-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="e-title">Title</FieldLabel>
              <Input id="e-title" {...form.register("title")} />
              <FieldError errors={[form.formState.errors.title]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="e-desc">Description</FieldLabel>
              <Textarea id="e-desc" rows={4} {...form.register("description")} />
            </Field>
            <Field orientation="horizontal">
              <Controller
                control={form.control}
                name="waitingRoomEnabled"
                render={({ field }) => <Switch id="e-wr" checked={field.value} onCheckedChange={field.onChange} />}
              />
              <div className="flex flex-col">
                <FieldLabel htmlFor="e-wr">Waiting room</FieldLabel>
                <FieldDescription>Takes effect on the next hold attempt.</FieldDescription>
              </div>
            </Field>
          </FieldGroup>
          <Button type="submit" className="w-fit" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            Save changes
          </Button>
        </CardContent>
      </form>
    </Card>
  )
}

function AssignScanner({ eventId }: { eventId: string }) {
  const [email, setEmail] = React.useState("")
  const [assigned, setAssigned] = React.useState<{ email: string; fullName: string }[]>([])
  const assign = useMutation({
    mutationFn: async (address: string) =>
      api<{ userId: string; email: string; fullName: string }>(`/catalog/events/${eventId}/scanners`, { method: "POST", body: { email: address } }),
    onSuccess: (r) => {
      toast.success(`${r.fullName} can now scan this event`)
      setAssigned((list) => [...list, { email: r.email, fullName: r.fullName }])
      setEmail("")
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not assign"),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TicketIcon className="size-4" />
          Gate scanners
        </CardTitle>
        <CardDescription>
          A scanner is hired per event. They sign in with their own account and open the scanner from the header.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (email.trim() !== "") assign.mutate(email.trim())
          }}
          className="flex gap-2"
        >
          <Input type="email" placeholder="scanner@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" disabled={assign.isPending || email.trim() === ""}>
            {assign.isPending ? <Spinner /> : "Assign"}
          </Button>
        </form>
        {assigned.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {assigned.map((a) => (
              <li key={a.email} className="flex justify-between">
                <span>{a.fullName}</span>
                <span className="text-muted-foreground">{a.email}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          The account must already exist. Assignments made in this session are listed above; the grant itself lives in
          identity and is what the scanner page checks.
        </p>
      </CardContent>
    </Card>
  )
}
