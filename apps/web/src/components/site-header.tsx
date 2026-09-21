"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ChevronDownIcon,
  FlaskConicalIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MapPinIcon,
  MenuIcon,
  ScanLineIcon,
  TicketsIcon,
  UserIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { Wordmark } from "@/components/logo"
import { ThemeToggle } from "@/components/theme-toggle"
import { SearchCommand } from "@/components/search-command"
import { NotificationsBell } from "@/components/notifications-bell"
import {
  hasRole,
  isPlatformAdmin,
  logout,
  organizedEventIds,
  scannableEventIds,
  useRefreshSession,
  useSession,
} from "@/lib/auth"
import { ALL_CITIES, useCity } from "@/lib/city"
import { useEvents } from "@/lib/queries"

function initials(name: string): string {
  return name
    .split(" ")
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
}

/** The city selector every ticketing app puts in its header. */
function CityPicker() {
  const [city, setCity] = useCity()
  const { data: events } = useEvents()
  const cities = [...new Set((events ?? []).map((e) => e.venue_city))].sort()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          <MapPinIcon className="size-4" />
          <span className="max-w-24 truncate">{city === ALL_CITIES ? "All cities" : city}</span>
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel>Your city</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={city} onValueChange={setCity}>
          <DropdownMenuRadioItem value={ALL_CITIES}>All cities</DropdownMenuRadioItem>
          {cities.map((c) => (
            <DropdownMenuRadioItem key={c} value={c}>
              {c}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
  const canOrganize = isPlatformAdmin(user) || hasRole(user, "organizer") || organizedEventIds(user).length > 0
  const canScan = isPlatformAdmin(user) || scannableEventIds(user).length > 0

  const onLogout = async (): Promise<void> => {
    await logout()
    refreshSession()
    router.push("/")
  }

  const links = [
    { href: "/proof", label: "Proof", icon: FlaskConicalIcon, show: true },
    { href: "/bookings", label: "My bookings", icon: TicketsIcon, show: isAuthenticated },
    { href: "/organizer", label: "Organizer", icon: LayoutDashboardIcon, show: canOrganize },
    { href: "/scan", label: "Scan", icon: ScanLineIcon, show: canScan },
  ].filter((l) => l.show)

  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur print:hidden">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-2 px-4">
        <Link href="/" className="shrink-0">
          <Wordmark className="text-lg" />
        </Link>
        <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />
        <div className="hidden sm:block">
          <CityPicker />
        </div>

        <nav className="ml-auto hidden items-center gap-1 md:flex">
          <SearchCommand />
          {links.map((l) => (
            <Button key={l.href} variant="ghost" size="sm" asChild>
              <Link href={l.href}>
                <l.icon className="size-4" />
                <span className="hidden lg:inline">{l.label}</span>
              </Link>
            </Button>
          ))}
          <NotificationsBell />
          <ThemeToggle />
        </nav>

        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <div className="md:hidden">
            <SearchCommand />
          </div>

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
                <DropdownMenuItem asChild>
                  <Link href="/bookings">
                    <TicketsIcon className="size-4" />
                    My bookings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/account">
                    <UserIcon className="size-4" />
                    Account
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void onLogout()}>
                  <LogOutIcon className="size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="hidden items-center gap-1 md:flex">
              <Button variant="ghost" size="sm" asChild>
                <Link href="/login">Sign in</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href="/register">Get started</Link>
              </Button>
            </div>
          )}

          {/* Mobile: everything else lives in a sheet. */}
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Menu">
                <MenuIcon className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetHeader>
                <SheetTitle>
                  <Wordmark />
                </SheetTitle>
              </SheetHeader>
              <div className="flex flex-col gap-1 px-4">
                <CityPicker />
                <Separator className="my-2" />
                <Button variant="ghost" className="justify-start" asChild>
                  <Link href="/">All events</Link>
                </Button>
                {links.map((l) => (
                  <Button key={l.href} variant="ghost" className="justify-start" asChild>
                    <Link href={l.href}>
                      <l.icon className="size-4" />
                      {l.label}
                    </Link>
                  </Button>
                ))}
                <Separator className="my-2" />
                {!isAuthenticated && (
                  <>
                    <Button variant="outline" asChild>
                      <Link href="/login">Sign in</Link>
                    </Button>
                    <Button asChild>
                      <Link href="/register">Get started</Link>
                    </Button>
                  </>
                )}
                <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
                  Theme
                  <ThemeToggle />
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
