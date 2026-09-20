"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useQueries } from "@tanstack/react-query"
import { useFieldArray, useForm, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { CalendarIcon, CheckIcon, CircleIcon, LoaderCircleIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Progress } from "@/components/ui/progress"
import { CreateVenueDialog } from "@/components/organizer/create-venue-dialog"
import { api, ApiError } from "@/lib/api"
import { pickUpNewGrants, useSession } from "@/lib/auth"
import { useEvents, useMyEvents } from "@/lib/queries"
import { formatShortDate } from "@/lib/format"
import type { Venue } from "@/lib/api-types"

const schema = z.object({
  title: z.string().min(1, "Give it a title").max(300),
  description: z.string().max(5000),
  venueId: z.string().uuid("Pick a venue"),
  date: z.date({ message: "Pick a date" }),
  hour: z.coerce.number().int().min(0).max(23),
  waitingRoom: z.boolean(),
  holdMinutes: z.coerce.number().int().min(1).max(60),
  release: z.enum(["draft", "published", "onsale"]),
  tiers: z.array(z.object({ name: z.string().min(1, "Name"), priceRupees: z.coerce.number().min(0, "≥ 0") })).min(1, "Add a tier"),
  sections: z
    .array(
      z.object({
        name: z.string().min(1, "Name").max(50),
        tierIndex: z.coerce.number().int().min(0),
        rows: z.coerce.number().int().min(1).max(500),
        seatsPerRow: z.coerce.number().int().min(1).max(500),
      })
    )
    .min(1, "Add a section"),
})
type Values = z.output<typeof schema>
// The form holds strings from <input>; zod coerces them. RHF is told both shapes.
type FormInput = z.input<typeof schema>

type Step = { label: string; state: "todo" | "doing" | "done" | "failed" }

export default function NewEventPage() {
  const router = useRouter()
  const { isAuthenticated } = useSession()
  const { data: publicEvents } = useEvents()
  const { data: myEvents } = useMyEvents(isAuthenticated)
  const [extraVenues, setExtraVenues] = React.useState<Venue[]>([])
  const [steps, setSteps] = React.useState<Step[] | null>(null)

  // Venues are not listable; the ones this account can see are the ones its
  // events reference, plus any created in this session.
  const venueIds = React.useMemo(
    () => [...new Set([...(publicEvents ?? []), ...(myEvents ?? [])].map((e) => e.venue_id))],
    [publicEvents, myEvents]
  )
  const venueQueries = useQueries({
    queries: venueIds.map((id) => ({
      queryKey: ["venue", id],
      queryFn: async () => api<Venue>(`/catalog/venues/${id}`),
      staleTime: 600_000,
    })),
  })
  const venues = React.useMemo(() => {
    const map = new Map<string, Venue>()
    for (const q of venueQueries) if (q.data !== undefined) map.set(q.data.venue_id, q.data)
    for (const v of extraVenues) map.set(v.venue_id, v)
    return [...map.values()].sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name))
  }, [venueQueries, extraVenues])

  const form = useForm<FormInput, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: "",
      description: "",
      venueId: "",
      hour: 19,
      waitingRoom: false,
      holdMinutes: 8,
      release: "onsale",
      tiers: [{ name: "Gold", priceRupees: 2500 }, { name: "Silver", priceRupees: 1200 }],
      sections: [{ name: "LOWER", tierIndex: 0, rows: 10, seatsPerRow: 20 }, { name: "UPPER", tierIndex: 1, rows: 12, seatsPerRow: 24 }],
    },
  })
  const tiers = useFieldArray({ control: form.control, name: "tiers" })
  const sections = useFieldArray({ control: form.control, name: "sections" })
  const watchedTiers = form.watch("tiers")
  const watchedSections = form.watch("sections")
  const totalSeats = watchedSections.reduce((n, s) => n + (Number(s.rows) || 0) * (Number(s.seatsPerRow) || 0), 0)

  const submit = async (values: Values): Promise<void> => {
    const plan: Step[] = [
      { label: "Create the event", state: "todo" },
      { label: "Pick up the organizer grant", state: "todo" },
      { label: `Add ${values.tiers.length} pricing tier${values.tiers.length === 1 ? "" : "s"}`, state: "todo" },
      { label: `Lay out ${values.sections.length} section${values.sections.length === 1 ? "" : "s"}`, state: "todo" },
      ...(values.release === "draft"
        ? []
        : [
            { label: values.release === "onsale" ? "Put on sale" : "Publish", state: "todo" as const },
            { label: `Provision ${totalSeats.toLocaleString("en-IN")} seats`, state: "todo" as const },
          ]),
    ]
    setSteps(plan)
    const mark = (i: number, state: Step["state"]) =>
      setSteps((s) => (s === null ? s : s.map((st, j) => (j === i ? { ...st, state } : st))))

    let step = 0
    try {
      mark(step, "doing")
      const startsAt = new Date(values.date)
      startsAt.setHours(values.hour, 0, 0, 0)
      const event = await api<{ event_id: string }>("/catalog/events", {
        method: "POST",
        body: {
          venueId: values.venueId,
          title: values.title,
          ...(values.description === "" ? {} : { description: values.description }),
          startsAt: startsAt.toISOString(),
          ...(values.release === "onsale" ? { onsaleAt: new Date().toISOString() } : {}),
          waitingRoomEnabled: values.waitingRoom,
          holdDurationSeconds: values.holdMinutes * 60,
        },
      })
      mark(step, "done")

      step = 1
      mark(step, "doing")
      // Creation just granted organizer:event:<id>. The token in memory predates
      // it, and everything below is authorized by it.
      await pickUpNewGrants()
      mark(step, "done")

      step = 2
      mark(step, "doing")
      const tierIds: string[] = []
      for (const tier of values.tiers) {
        const created = await api<{ tier_id: string }>(`/catalog/events/${event.event_id}/tiers`, {
          method: "POST",
          body: { name: tier.name, pricePaise: Math.round(tier.priceRupees * 100) },
        })
        tierIds.push(created.tier_id)
      }
      mark(step, "done")

      step = 3
      mark(step, "doing")
      for (const section of values.sections) {
        await api(`/catalog/events/${event.event_id}/sections`, {
          method: "POST",
          body: { tierId: tierIds[section.tierIndex], name: section.name, rowCount: section.rows, seatsPerRow: section.seatsPerRow },
        })
      }
      mark(step, "done")

      if (values.release !== "draft") {
        step = 4
        mark(step, "doing")
        await api(`/catalog/events/${event.event_id}/publish`, { method: "POST", body: { onsale: values.release === "onsale" } })
        mark(step, "done")

        step = 5
        mark(step, "doing")
        await api(`/inventory/${event.event_id}/seats`, {
          method: "POST",
          body: {
            sections: values.sections.map((s) => ({ name: s.name, tierId: tierIds[s.tierIndex], rowCount: s.rows, seatsPerRow: s.seatsPerRow })),
          },
        })
        mark(step, "done")
      }

      toast.success(`${values.title} created`)
      router.push("/organizer")
    } catch (error) {
      mark(step, "failed")
      toast.error(error instanceof ApiError ? error.message : "Something went wrong", {
        description: error instanceof ApiError ? error.requestId : undefined,
      })
    }
  }

  const doneCount = steps?.filter((s) => s.state === "done").length ?? 0

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[1fr_300px]">
      <form onSubmit={form.handleSubmit(submit)} noValidate className="flex flex-col gap-6">
        {/* ── basics ───────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Basics</CardTitle>
            <CardDescription>What, where and when.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="title">Title</FieldLabel>
                <Input id="title" placeholder="Arijit Singh — Live in Concert" {...form.register("title")} />
                <FieldError errors={[form.formState.errors.title]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="description">Description</FieldLabel>
                <Textarea id="description" rows={3} placeholder="Doors, age limit, what to expect…" {...form.register("description")} />
              </Field>

              <Field>
                <FieldLabel htmlFor="venue">Venue</FieldLabel>
                <div className="flex gap-2">
                  <NativeSelect id="venue" className="flex-1" {...form.register("venueId")}>
                    <NativeSelectOption value="">Choose a venue…</NativeSelectOption>
                    {venues.map((v) => (
                      <NativeSelectOption key={v.venue_id} value={v.venue_id}>
                        {v.name} — {v.city}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <CreateVenueDialog
                    onCreated={(venue) => {
                      setExtraVenues((list) => [...list, venue])
                      form.setValue("venueId", venue.venue_id, { shouldValidate: true })
                    }}
                  >
                    <Button type="button" variant="outline">
                      <PlusIcon className="size-4" />
                      New
                    </Button>
                  </CreateVenueDialog>
                </div>
                <FieldError errors={[form.formState.errors.venueId]} />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>Date</FieldLabel>
                  <Controller
                    control={form.control}
                    name="date"
                    render={({ field }) => (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button type="button" variant="outline" className="justify-start font-normal">
                            <CalendarIcon className="size-4" />
                            {field.value ? formatShortDate(field.value.toISOString()) : "Pick a date"}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={field.value}
                            onSelect={(d) => field.onChange(d)}
                            disabled={{ before: new Date() }}
                          />
                        </PopoverContent>
                      </Popover>
                    )}
                  />
                  <FieldError errors={[form.formState.errors.date]} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="hour">Start time</FieldLabel>
                  <NativeSelect id="hour" {...form.register("hour")}>
                    {Array.from({ length: 24 }, (_, h) => (
                      <NativeSelectOption key={h} value={String(h)}>
                        {`${((h + 11) % 12) + 1}:00 ${h < 12 ? "AM" : "PM"}`}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>

        {/* ── selling rules ────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Selling rules</CardTitle>
            <CardDescription>How buyers get in and how long they may hold seats.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field orientation="horizontal">
                  <Controller
                    control={form.control}
                    name="waitingRoom"
                    render={({ field }) => <Switch id="wr" checked={field.value} onCheckedChange={field.onChange} />}
                  />
                  <div className="flex flex-col">
                    <FieldLabel htmlFor="wr">Waiting room</FieldLabel>
                    <FieldDescription>Admit buyers in batches for high-demand sales.</FieldDescription>
                  </div>
                </Field>
                <Field>
                  <FieldLabel htmlFor="hold">Hold window</FieldLabel>
                  <NativeSelect id="hold" {...form.register("holdMinutes")}>
                    {[3, 5, 8, 10, 15, 20].map((m) => (
                      <NativeSelectOption key={m} value={String(m)}>
                        {m} minutes
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <FieldDescription>Seats return to sale automatically when it ends.</FieldDescription>
                </Field>
              </div>

              <Field>
                <FieldLabel>Release</FieldLabel>
                <Controller
                  control={form.control}
                  name="release"
                  render={({ field }) => (
                    <RadioGroup value={field.value} onValueChange={field.onChange} className="grid gap-2 sm:grid-cols-3">
                      {(
                        [
                          ["draft", "Draft", "Only you can see it."],
                          ["published", "Publish", "Listed as coming soon."],
                          ["onsale", "On sale now", "Seats provisioned and buyable."],
                        ] as const
                      ).map(([value, label, hint]) => (
                        <Label
                          key={value}
                          htmlFor={`release-${value}`}
                          className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary"
                        >
                          <RadioGroupItem id={`release-${value}`} value={value} className="mt-0.5" />
                          <span className="flex flex-col gap-0.5">
                            <span className="font-medium">{label}</span>
                            <span className="text-xs font-normal text-muted-foreground">{hint}</span>
                          </span>
                        </Label>
                      ))}
                    </RadioGroup>
                  )}
                />
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        {/* ── tiers ────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Pricing tiers</CardTitle>
            <CardDescription>Every section belongs to exactly one tier.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {tiers.fields.map((f, i) => (
              <div key={f.id} className="grid grid-cols-[1fr_140px_auto] items-start gap-2">
                <Field>
                  <Input placeholder="Tier name" {...form.register(`tiers.${i}.name`)} />
                  <FieldError errors={[form.formState.errors.tiers?.[i]?.name]} />
                </Field>
                <Field>
                  <div className="relative">
                    <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
                    <Input type="number" min={0} step={1} className="pl-7" {...form.register(`tiers.${i}.priceRupees`)} />
                  </div>
                  <FieldError errors={[form.formState.errors.tiers?.[i]?.priceRupees]} />
                </Field>
                <Button type="button" variant="ghost" size="icon" aria-label="Remove tier" disabled={tiers.fields.length === 1} onClick={() => tiers.remove(i)}>
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => tiers.append({ name: "", priceRupees: 0 })}>
              <PlusIcon className="size-4" />
              Add tier
            </Button>
          </CardContent>
        </Card>

        {/* ── sections ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Seatmap</CardTitle>
            <CardDescription>
              Sections are a grid of rows × seats. {totalSeats.toLocaleString("en-IN")} seats total.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {sections.fields.map((f, i) => (
              <div key={f.id} className="grid grid-cols-[1fr_1fr_90px_90px_auto] items-start gap-2">
                <Field>
                  <Input placeholder="Section" {...form.register(`sections.${i}.name`)} />
                  <FieldError errors={[form.formState.errors.sections?.[i]?.name]} />
                </Field>
                <NativeSelect {...form.register(`sections.${i}.tierIndex`)}>
                  {watchedTiers.map((t, ti) => (
                    <NativeSelectOption key={ti} value={String(ti)}>
                      {t.name || `Tier ${ti + 1}`}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Input type="number" min={1} max={500} placeholder="Rows" {...form.register(`sections.${i}.rows`)} />
                <Input type="number" min={1} max={500} placeholder="Seats" {...form.register(`sections.${i}.seatsPerRow`)} />
                <Button type="button" variant="ghost" size="icon" aria-label="Remove section" disabled={sections.fields.length === 1} onClick={() => sections.remove(i)}>
                  <Trash2Icon className="size-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => sections.append({ name: "", tierIndex: 0, rows: 10, seatsPerRow: 20 })}>
              <PlusIcon className="size-4" />
              Add section
            </Button>
          </CardContent>
        </Card>

        <Button type="submit" size="lg" disabled={form.formState.isSubmitting || (steps !== null && steps.some((s) => s.state === "doing"))}>
          {form.formState.isSubmitting && <LoaderCircleIcon className="size-4 animate-spin" />}
          Create event
        </Button>
      </form>

      {/* ── progress ─────────────────────────────────────────────────── */}
      <aside className="lg:sticky lg:top-20 lg:h-fit">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What happens</CardTitle>
            <CardDescription>Each step is its own call to the service that owns it.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {steps !== null && <Progress value={(doneCount / steps.length) * 100} />}
            <ol className="flex flex-col gap-2 text-sm">
              {(steps ?? [
                { label: "Create the event", state: "todo" as const },
                { label: "Pick up the organizer grant", state: "todo" as const },
                { label: "Add pricing tiers", state: "todo" as const },
                { label: "Lay out sections", state: "todo" as const },
                { label: "Publish / put on sale", state: "todo" as const },
                { label: "Provision seats", state: "todo" as const },
              ]).map((s, i) => (
                <li key={i} className="flex items-center gap-2">
                  {s.state === "done" ? (
                    <CheckIcon className="size-4 text-emerald-500" />
                  ) : s.state === "doing" ? (
                    <LoaderCircleIcon className="size-4 animate-spin" />
                  ) : s.state === "failed" ? (
                    <CircleIcon className="size-4 fill-destructive text-destructive" />
                  ) : (
                    <CircleIcon className="size-4 text-muted-foreground/40" />
                  )}
                  <span className={s.state === "todo" ? "text-muted-foreground" : ""}>{s.label}</span>
                </li>
              ))}
            </ol>
            <Separator />
            <p className="text-xs text-muted-foreground">
              Catalog owns the event and its geometry; reservation owns the seats and creates them last.
              The grant step exists because reservation cannot see who owns an event.
            </p>
          </CardContent>
        </Card>
      </aside>
    </div>
  )
}
