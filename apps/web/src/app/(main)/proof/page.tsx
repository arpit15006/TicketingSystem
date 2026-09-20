"use client"

import * as React from "react"
import { Suspense } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { CheckCircle2Icon, FlaskConicalIcon, LoaderCircleIcon, XCircleIcon, ZapIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Slider } from "@/components/ui/slider"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { forceRefresh } from "@/lib/api"
import { getAccessToken } from "@/lib/tokens"
import { useSession } from "@/lib/auth"
import { useEvents } from "@/lib/queries"

interface Result {
  requests: number
  seats: number
  outcomes: { won: number; lost: number; rateLimited: number; other: number }
  distinctWinningSeats: number
  duplicateWins: number
  availabilityBefore: number
  availabilityAfter: number
  expectedAfter: number
  availabilityRestored: number
  released: number
  latencyMs: { p50: number; p95: number; p99: number; max: number }
  wallMs: number
  inFlightCap: number
  metrics: Record<string, number> | null
  sampleRequestIds: string[]
}

export default function ProofPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <Proof />
    </Suspense>
  )
}

function Proof() {
  const params = useSearchParams()
  const { isAuthenticated, isLoading } = useSession()
  const { data: events } = useEvents("onsale")
  const [chosenEventId, setEventId] = React.useState(params.get("event") ?? "")
  // Default to the first on-sale event without mirroring it into state.
  const eventId = chosenEventId !== "" ? chosenEventId : (events?.[0]?.event_id ?? "")
  const [requests, setRequests] = React.useState(200)
  const [seats, setSeats] = React.useState(20)
  const [running, setRunning] = React.useState(false)
  const [result, setResult] = React.useState<Result | null>(null)

  const fire = async (): Promise<void> => {
    setRunning(true)
    setResult(null)
    try {
      let token = getAccessToken()
      if (token === null) token = await forceRefresh()
      if (token === null) throw new Error("Sign in first")
      const r = await fetch("/api/proof", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ eventId, requests, seats }),
      })
      const body = (await r.json()) as Result & { error?: string }
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
      setResult(body)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The storm failed to start")
    } finally {
      setRunning(false)
    }
  }

  if (!isLoading && !isAuthenticated) {
    return (
      <Alert className="mx-auto max-w-md">
        <AlertTitle>Sign in to run the proof</AlertTitle>
        <AlertDescription>
          The storm holds real seats with your account, then releases them.
          <Button size="sm" className="mt-2" asChild>
            <Link href="/login?next=/proof">Sign in</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  const passed =
    result !== null &&
    result.duplicateWins === 0 &&
    result.outcomes.won === Math.min(result.seats, result.outcomes.won + result.outcomes.lost) &&
    result.availabilityAfter === result.expectedAfter &&
    (result.metrics?.oversell_total ?? 0) === 0

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <FlaskConicalIcon className="size-6" />
          Prove it: a seat is never sold twice
        </h1>
        <p className="text-muted-foreground">
          Fire hundreds of simultaneous hold requests at a handful of seats. Exactly one request per seat
          can win; every other one must lose with a <code className="font-mono text-xs">409</code>. Then
          the holds are released and the count checked.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">The storm</CardTitle>
            <CardDescription>Runs from the app server so requests genuinely overlap.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field>
              <FieldLabel htmlFor="event">Event</FieldLabel>
              <NativeSelect id="event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
                {(events ?? []).map((e) => (
                  <NativeSelectOption key={e.event_id} value={e.event_id}>
                    {e.title}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel>Requests: {requests}</FieldLabel>
              <Slider min={20} max={300} step={10} value={[requests]} onValueChange={(v) => setRequests(v[0] ?? 200)} />
              <FieldDescription>Capped at 300 — the gateway&apos;s per-IP rate limit per minute.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Seats under contention: {Math.min(seats, requests)}</FieldLabel>
              <Slider min={1} max={100} step={1} value={[seats]} onValueChange={(v) => setSeats(v[0] ?? 20)} />
              <FieldDescription>
                About {Math.round(requests / Math.max(1, Math.min(seats, requests)))} requests will fight over each seat.
              </FieldDescription>
            </Field>
            <Button size="lg" onClick={() => void fire()} disabled={running || eventId === ""}>
              {running ? <LoaderCircleIcon className="size-4 animate-spin" /> : <ZapIcon className="size-4" />}
              {running ? "Firing…" : `Fire ${requests} requests`}
            </Button>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          {result === null && !running && (
            <Card className="flex h-full items-center justify-center border-dashed">
              <CardContent className="py-16 text-center text-sm text-muted-foreground">
                Results appear here. Nothing below is assumed — every number is counted from a real response.
              </CardContent>
            </Card>
          )}
          {running && <Skeleton className="h-80 w-full rounded-xl" />}

          {result !== null && (
            <>
              <Alert className={passed ? "border-emerald-500/50 bg-emerald-500/5" : "border-destructive"}>
                {passed ? <CheckCircle2Icon className="size-4 text-emerald-500" /> : <XCircleIcon className="size-4 text-destructive" />}
                <AlertTitle className="text-lg">
                  {passed ? "No seat was allocated twice" : "Something is off — read the numbers"}
                </AlertTitle>
                <AlertDescription>
                  {result.requests} requests · {result.seats} seats · {result.wallMs} ms wall clock · up to{" "}
                  {result.inFlightCap} in flight
                </AlertDescription>
              </Alert>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Won (201)" value={result.outcomes.won} tone="good" />
                <Stat label="Lost (409)" value={result.outcomes.lost} />
                <Stat label="Rate limited (429)" value={result.outcomes.rateLimited} tone={result.outcomes.rateLimited > 0 ? "warn" : undefined} />
                <Stat label="Failed / other" value={result.outcomes.other} tone={result.outcomes.other > 0 ? "warn" : undefined} />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">The checks</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <Table>
                    <TableBody>
                      <Check ok={result.duplicateWins === 0} label="Every winning seat id is distinct" detail={`${result.distinctWinningSeats} distinct of ${result.outcomes.won} wins, ${result.duplicateWins} duplicates`} />
                      <Check ok={result.outcomes.won <= result.seats} label="Wins never exceed the seats under contention" detail={`${result.outcomes.won} ≤ ${result.seats}`} />
                      <Check ok={result.availabilityAfter === result.expectedAfter} label="Availability dropped by exactly the number of wins" detail={`${result.availabilityBefore} → ${result.availabilityAfter} (expected ${result.expectedAfter})`} />
                      <Check ok={result.metrics === null || result.metrics.oversell_total === 0} label="Service reports oversell_total = 0" detail={result.metrics === null ? "metrics unavailable" : `oversell_total ${result.metrics.oversell_total}`} />
                      <Check ok={result.availabilityRestored === result.availabilityBefore} label="Every hold released afterwards" detail={`${result.released} released, availability back to ${result.availabilityRestored}`} />
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Latency, hold acquisition</CardTitle>
                  <CardDescription>Measured at the app server, through the gateway, on this machine.</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-4 gap-3 pt-0 text-center">
                  {(["p50", "p95", "p99", "max"] as const).map((k) => (
                    <div key={k}>
                      <p className="text-xs text-muted-foreground">{k}</p>
                      <p className="text-xl font-semibold tabular-nums">{result.latencyMs[k]} ms</p>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {result.metrics !== null && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Reservation service counters</CardTitle>
                    <CardDescription>Straight from <code className="font-mono text-xs">/metrics</code>. Process-lifetime, not per run.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2 pt-0">
                    {Object.entries(result.metrics).map(([k, v]) => (
                      <Badge key={k} variant={k === "oversell_total" ? (v === 0 ? "default" : "destructive") : "secondary"} className="font-mono">
                        {k} {v}
                      </Badge>
                    ))}
                  </CardContent>
                </Card>
              )}

              <Separator />
              <p className="text-xs text-muted-foreground">
                What this shows: under real contention the conditional <code className="font-mono">UPDATE</code> lets exactly one
                request win each seat, with no lock and no retry. What it does not show: throughput at scale — the app server,
                gateway and database all share this machine, and the rate limiter caps a run at 300. The 1,000-request proof
                with a server-side in-flight gauge is in the test suite.
                {result.sampleRequestIds.length > 0 && (
                  <>
                    {" "}Trace a request: <span className="font-mono">{result.sampleRequestIds[0]}</span>
                  </>
                )}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" | "warn" | undefined }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-3xl font-semibold tabular-nums ${tone === "good" ? "text-emerald-500" : tone === "warn" ? "text-amber-500" : ""}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  )
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <TableRow>
      <TableCell className="w-8">
        {ok ? <CheckCircle2Icon className="size-4 text-emerald-500" /> : <XCircleIcon className="size-4 text-destructive" />}
      </TableCell>
      <TableCell className="font-medium">{label}</TableCell>
      <TableCell className="text-right font-mono text-xs text-muted-foreground">{detail}</TableCell>
    </TableRow>
  )
}
