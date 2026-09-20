"use client"

import * as React from "react"
import Link from "next/link"
import { CameraIcon, CameraOffIcon, CheckCircle2Icon, ScanLineIcon, XCircleIcon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { api, ApiError } from "@/lib/api"
import { scannableEventIds, isPlatformAdmin, useSession } from "@/lib/auth"
import { useEvents } from "@/lib/queries"
import type { ScanResult } from "@/lib/api-types"

type Outcome =
  | { kind: "admitted"; result: ScanResult }
  | { kind: "already"; result: ScanResult }
  | { kind: "refused"; message: string; requestId?: string }

/**
 * PRD §13 `/scan` — the gate.
 *
 * Two inputs, one contract. A handheld scanner types the code in as keyboard
 * input, so the manual tab works with no permissions prompt; the camera tab uses
 * the phone's camera for the same POST. Either way the server decides with a
 * conditional UPDATE, so exactly one scan of a ticket ever reports `admitted` —
 * a re-read or a forwarded screenshot gets a clear "already scanned", not a
 * second open gate.
 */
export default function ScanPage() {
  const { user, isAuthenticated, isLoading: sessionLoading } = useSession()
  const { data: events } = useEvents()
  const [code, setCode] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const [history, setHistory] = React.useState<Outcome[]>([])
  const inputRef = React.useRef<HTMLInputElement>(null)

  const assigned = React.useMemo(() => {
    const ids = new Set(scannableEventIds(user))
    return (events ?? []).filter((e) => isPlatformAdmin(user) || ids.has(e.event_id))
  }, [events, user])

  const scan = React.useCallback(async (qrToken: string): Promise<void> => {
    const trimmed = qrToken.trim()
    if (trimmed === "" || busy) return
    setBusy(true)
    let next: Outcome
    try {
      const result = await api<ScanResult>("/tickets/scan", { method: "POST", body: { qrToken: trimmed } })
      next = result.admitted ? { kind: "admitted", result } : { kind: "already", result }
      setCode("")
    } catch (error) {
      next =
        error instanceof ApiError
          ? { kind: "refused", message: error.message, requestId: error.requestId }
          : { kind: "refused", message: "Could not reach the ticketing service" }
    }
    setOutcome(next)
    setHistory((h) => [next, ...h].slice(0, 8))
    setBusy(false)
    inputRef.current?.focus()
  }, [busy])

  if (!sessionLoading && !isAuthenticated) {
    return (
      <Alert className="mx-auto max-w-md">
        <AlertTitle>Sign in required</AlertTitle>
        <AlertDescription>
          <Button size="sm" className="mt-2" asChild>
            <Link href="/login?next=/scan">Sign in</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ScanLineIcon className="size-6" />
            Gate scanner
          </h1>
          <p className="text-sm text-muted-foreground">
            Assigned to {assigned.length} event{assigned.length === 1 ? "" : "s"}. Scanning a ticket for any
            other event is refused.
          </p>
        </div>

        <Tabs defaultValue="manual">
          <TabsList>
            <TabsTrigger value="manual">Handheld / manual</TabsTrigger>
            <TabsTrigger value="camera">
              <CameraIcon className="size-3.5" />
              Camera
            </TabsTrigger>
          </TabsList>

          <TabsContent value="manual">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Ticket code</CardTitle>
              </CardHeader>
              <CardContent>
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    void scan(code)
                  }}
                  className="flex gap-2"
                >
                  <Input
                    ref={inputRef}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="Scan or paste the code"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                  <Button type="submit" disabled={busy || code.trim() === ""}>
                    {busy ? <Spinner /> : "Scan"}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="camera">
            <CameraScanner onCode={(value) => void scan(value)} paused={busy} />
          </TabsContent>
        </Tabs>

        {outcome !== null && <OutcomeAlert outcome={outcome} />}
      </div>

      <aside className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Recent</h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing scanned yet.</p>
        ) : (
          history.map((h, i) => (
            <Item key={i} variant="outline" size="sm">
              <ItemMedia variant="icon">
                {h.kind === "admitted" ? (
                  <CheckCircle2Icon className="text-emerald-500" />
                ) : h.kind === "already" ? (
                  <RotateCcwIcon className="text-amber-500" />
                ) : (
                  <XCircleIcon className="text-destructive" />
                )}
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {h.kind === "admitted" ? "Admitted" : h.kind === "already" ? "Already scanned" : "Refused"}
                </ItemTitle>
                <ItemDescription className="font-mono text-[10px]">
                  {h.kind === "refused" ? h.message : h.result.seatId.slice(0, 18) + "…"}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))
        )}
      </aside>
    </div>
  )
}

function OutcomeAlert({ outcome }: { outcome: Outcome }) {
  if (outcome.kind === "admitted") {
    return (
      <Alert className="border-emerald-500/50 bg-emerald-500/5">
        <CheckCircle2Icon className="size-4 text-emerald-500" />
        <AlertTitle className="text-lg">Admit</AlertTitle>
        <AlertDescription className="flex flex-col gap-1">
          <span className="font-mono text-xs">seat {outcome.result.seatId}</span>
          <Badge variant="secondary" className="w-fit">first scan</Badge>
        </AlertDescription>
      </Alert>
    )
  }
  if (outcome.kind === "already") {
    return (
      <Alert variant="destructive">
        <RotateCcwIcon className="size-4" />
        <AlertTitle className="text-lg">Already scanned</AlertTitle>
        <AlertDescription className="flex flex-col gap-1">
          <span>
            Used{outcome.result.scannedAt === null ? "" : ` at ${new Date(outcome.result.scannedAt).toLocaleTimeString("en-IN")}`}.
            Do not admit.
          </span>
          <span className="font-mono text-xs">seat {outcome.result.seatId}</span>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive">
      <XCircleIcon className="size-4" />
      <AlertTitle>{outcome.message}</AlertTitle>
      {outcome.requestId !== undefined && (
        <AlertDescription>
          <span className="font-mono text-xs">{outcome.requestId}</span>
        </AlertDescription>
      )}
    </Alert>
  )
}

/**
 * Camera decoding via @zxing/browser. The reader is created on demand and
 * stopped on unmount or tab change, or the camera light stays on after the user
 * has left the page.
 */
function CameraScanner({ onCode, paused }: { onCode: (value: string) => void; paused: boolean }) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const [active, setActive] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [scans, setScans] = React.useState(0)
  const lastRef = React.useRef<{ value: string; at: number }>({ value: "", at: 0 })

  /*
   * The callback and the paused flag are read through refs so the decode loop
   * depends on nothing but `active`. The first version listed `onCode` as an
   * effect dependency; it is a new function on every render, so the first
   * successful scan (which re-rendered the page) tore the reader down and the
   * camera had to be started again by hand. Now the reader lives for as long as
   * the camera is on and reports every code it sees, once each.
   */
  const onCodeRef = React.useRef(onCode)
  const pausedRef = React.useRef(paused)
  React.useEffect(() => {
    onCodeRef.current = onCode
    pausedRef.current = paused
  }, [onCode, paused])

  React.useEffect(() => {
    if (!active) return
    const video = videoRef.current
    if (video === null) return
    let controls: { stop: () => void } | null = null
    let cancelled = false

    void (async () => {
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser")
        const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanSuccess: 300, delayBetweenScanAttempts: 100 })
        const started = await reader.decodeFromVideoDevice(undefined, video, (result) => {
          if (result === undefined || pausedRef.current) return
          const text = result.getText()
          // The same code sits in front of the camera for many frames; report it
          // once, but let it through again after a moment so a re-scan is possible.
          const now = Date.now()
          if (text === lastRef.current.value && now - lastRef.current.at < 3000) return
          lastRef.current = { value: text, at: now }
          setScans((n) => n + 1)
          onCodeRef.current(text)
        })
        if (cancelled) started.stop()
        else controls = started
      } catch (e) {
        setError(e instanceof Error ? e.message : "Camera unavailable")
        setActive(false)
      }
    })()

    return () => {
      cancelled = true
      controls?.stop()
    }
  }, [active])

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
          <video ref={videoRef} className="size-full object-cover" muted playsInline />
          {!active && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
              <CameraOffIcon className="mr-2 size-4" />
              Camera off
            </div>
          )}
          {active && (
            <>
              <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-white/60" />
              <Badge className="absolute top-3 right-3 bg-black/50 text-white backdrop-blur hover:bg-black/50">
                Scanning · {scans} read
              </Badge>
            </>
          )}
        </div>
        {error !== null && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">
          Keeps scanning until you stop it. Point at the next ticket; each code is reported once.
        </p>
        <Button variant={active ? "outline" : "default"} onClick={() => setActive((v) => !v)}>
          {active ? <CameraOffIcon className="size-4" /> : <CameraIcon className="size-4" />}
          {active ? "Stop camera" : "Start camera"}
        </Button>
      </CardContent>
    </Card>
  )
}
