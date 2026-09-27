"use client"

import { ChevronRightIcon, TicketIcon } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { DEMO_ICONS, useDemoAccounts, useDemoSignIn } from "@/lib/demo"

/**
 * The evaluator's door. Four seeded accounts, one press each.
 *
 * Roles are not a setting on one account here — they are separate accounts with
 * separate grants, because that is what the authorization model actually is.
 * Signing in as the scanner lands on the gate rather than the home page, so the
 * role's work is the first thing on screen (§16, wayfinding).
 *
 * No passphrase reaches this component: it posts a role name and receives the
 * same token pair the sign-in form would have produced.
 */
export function DemoAccounts({ onStart }: { onStart?: (() => void) | undefined } = {}) {
  const accounts = useDemoAccounts()
  const { signIn, busy, error } = useDemoSignIn(onStart)

  if (accounts !== null && accounts.length === 0) return null

  return (
    <section aria-labelledby="demo-heading" className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <h2 id="demo-heading" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Or explore a demo account
        </h2>
        <span className="h-px flex-1 bg-border" />
      </div>

      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        {accounts === null
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)
          : accounts.map((account) => {
              const Icon = DEMO_ICONS[account.role] ?? TicketIcon
              const running = busy === account.role
              return (
                <button
                  key={account.role}
                  type="button"
                  onClick={() => void signIn(account)}
                  disabled={busy !== null}
                  className="press-sm group flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-hover:bg-background">
                    {running ? <Spinner className="size-4" /> : <Icon className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{account.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">{account.blurb}</span>
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              )
            })}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Seeded accounts on a test database, in Razorpay test mode.
      </p>
    </section>
  )
}
