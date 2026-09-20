"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { LogOutIcon, ScanLineIcon, LayoutDashboardIcon, TicketIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Skeleton } from "@/components/ui/skeleton"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  hasRole,
  isPlatformAdmin,
  logout,
  organizedEventIds,
  scannableEventIds,
  useRefreshSession,
  useSession,
} from "@/lib/auth"

function initials(name: string): string {
  return name
    .split(" ")
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
}

export function SiteHeader() {
  const { user, isLoading, isAuthenticated } = useSession()
  const refreshSession = useRefreshSession()
  const router = useRouter()

  /*
   * These decide what the header *offers*, never what the user may do. Every
   * service re-checks the permission itself (ADR-010) — hiding a link the server
   * would refuse is a courtesy, not a control.
   */
  const canOrganize =
    isPlatformAdmin(user) || hasRole(user, "organizer") || organizedEventIds(user).length > 0
  const canScan = isPlatformAdmin(user) || scannableEventIds(user).length > 0

  const onLogout = async (): Promise<void> => {
    await logout()
    refreshSession()
    router.push("/")
  }

  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <TicketIcon className="size-5" />
          <span>Ticketing</span>
        </Link>

        <nav className="ml-auto flex items-center gap-1">
          {canOrganize && (
            <Button variant="ghost" size="sm" asChild>
              <Link href="/organizer">
                <LayoutDashboardIcon className="size-4" />
                <span className="hidden sm:inline">Organizer</span>
              </Link>
            </Button>
          )}
          {canScan && (
            <Button variant="ghost" size="sm" asChild>
              <Link href="/scan">
                <ScanLineIcon className="size-4" />
                <span className="hidden sm:inline">Scan</span>
              </Link>
            </Button>
          )}

          <ThemeToggle />

          {isLoading ? (
            <Skeleton className="size-8 rounded-full" />
          ) : isAuthenticated && user !== null ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account">
                  <Avatar className="size-8">
                    <AvatarFallback className="text-xs">{initials(user.fullName)}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="flex flex-col">
                  <span>{user.fullName}</span>
                  <span className="text-xs font-normal text-muted-foreground">{user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void onLogout()}>
                  <LogOutIcon className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/login">Sign in</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href="/register">Get started</Link>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  )
}
