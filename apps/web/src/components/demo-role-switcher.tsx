"use client"

import { CheckIcon, FlaskConicalIcon, TicketIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { useSession } from "@/lib/auth"
import { DEMO_ICONS, useDemoAccounts, useDemoSignIn } from "@/lib/demo"
import { cn } from "cn"

/**
 * Switch roles from anywhere, without going back to the sign-in page.
 *
 * Roles here are separate accounts with separate grants, not a setting — so
 * this really does sign out and sign in again, and the current account is
 * ticked so it is never a guess which one you are looking at. Each choice
 * lands on the work that role does rather than the home page.
 *
 * Renders nothing when the deployment offers no demo accounts, which is what
 * `DEMO_LOGINS=0` produces.
 */
export function DemoRoleSwitcher({ className }: { className?: string }) {
  const accounts = useDemoAccounts()
  const { signIn, busy } = useDemoSignIn()
  const { user } = useSession()

  if (accounts === null || accounts.length === 0) return null

  const current = accounts.find((a) => a.email === user?.email)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("gap-1.5", className)}>
          {busy !== null ? <Spinner className="size-4" /> : <FlaskConicalIcon className="size-4" />}
          <span className="hidden lg:inline">{current?.label ?? "Demo"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          Sign in as
          <span className="text-xs font-normal text-muted-foreground">
            Seeded accounts, Razorpay test mode.
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {accounts.map((account) => {
            const Icon = DEMO_ICONS[account.role] ?? TicketIcon
            const active = current?.role === account.role
            return (
              <DropdownMenuItem
                key={account.role}
                disabled={busy !== null}
                onSelect={(event) => {
                  // The menu closes on select; without this the navigation races
                  // the close animation and the page changes under a moving menu.
                  event.preventDefault()
                  void signIn(account)
                }}
                className="gap-2.5"
              >
                {busy === account.role ? (
                  <Spinner className="size-4 shrink-0" />
                ) : (
                  <Icon className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{account.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{account.blurb}</span>
                </span>
                {active && <CheckIcon className="size-4 shrink-0" aria-label="Signed in as this role" />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
