"use client"

import * as React from "react"
import Link from "next/link"
import { CheckCircle2Icon, ScanLineIcon, XCircleIcon, RotateCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { api, ApiError } from "@/lib/api"
import { useSession } from "@/lib/auth"
import type { ScanResult } from "@/lib/api-types"

type Outcome =
  | { kind: "admitted"; result: ScanResult }
  | { kind: "already"; result: ScanResult }
  | { kind: "refused"; message: string; requestId?: string }

/**
 * PRD §13 `/scan` — the gate.
 *
 * Manual entry rather than a camera by default: a gate scanner is usually a
 * dedicated handheld that types the code in as keyboard input, and that path
 * works here with no permissions prompt. The camera is a nicety this page does
 * not need in order to be real.
 *
 * The important behaviour is that a second scan of a valid ticket is a normal
 * answer, not an error. Codes get re-read constantly and screenshots get
 * forwarded; the server decides with a conditional UPDATE, so exactly one scan
 * ever reports `admitted`.
 */
export default function ScanPage() {
  const { isAuthenticated, isLoading: sessionLoading } = useSession()
  const [code, setCode] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const scan = async (): Promise<void> => {
    const qrToken = code.trim()
    if (qrToken === "") return

    setBusy(true)
    try {
      const result = await api<ScanResult>("/tickets/scan", {
        method: "POST",
        body: { qrToken },
      })
      setOutcome(result.admitted ? { kind: "admitted", result } : { kind: "already", result })
      setCode("")
    } catch (error) {
      setOutcome(
        error instanceof ApiError
          ? { kind: "refused", message: error.message, requestId: error.requestId }
          : { kind: "refused", message: "Could not reach the ticketing service" }
      )
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

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
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ScanLineIcon className="size-6" />
          Gate scanner
        </h1>
        <p className="text-muted-foreground">
          Scan or type a ticket code. Scanning needs a grant for that specific event.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ticket code</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void scan()
            }}
            className="flex gap-2"
          >
            <Input
              ref={inputRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste or scan the code"
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

      {outcome !== null && (
        <>
          {outcome.kind === "admitted" && (
            <Alert>
              <CheckCircle2Icon className="size-4" />
              <AlertTitle>Admit</AlertTitle>
              <AlertDescription className="flex flex-col gap-1">
                <span className="font-mono text-xs">seat {outcome.result.seatId}</span>
                <Badge variant="secondary" className="w-fit">first scan</Badge>
              </AlertDescription>
            </Alert>
          )}

          {outcome.kind === "already" && (
            <Alert variant="destructive">
              <RotateCcwIcon className="size-4" />
              <AlertTitle>Already scanned</AlertTitle>
              <AlertDescription className="flex flex-col gap-1">
                <span>
                  This ticket was used
                  {outcome.result.scannedAt === null
                    ? ""
                    : ` at ${new Date(outcome.result.scannedAt).toLocaleTimeString("en-IN")}`}
                  .
                </span>
                <span className="font-mono text-xs">seat {outcome.result.seatId}</span>
              </AlertDescription>
            </Alert>
          )}

          {outcome.kind === "refused" && (
            <Alert variant="destructive">
              <XCircleIcon className="size-4" />
              <AlertTitle>{outcome.message}</AlertTitle>
              {outcome.requestId !== undefined && (
                <AlertDescription>
                  <span className="font-mono text-xs">{outcome.requestId}</span>
                </AlertDescription>
              )}
            </Alert>
          )}
        </>
      )}
    </div>
  )
}
