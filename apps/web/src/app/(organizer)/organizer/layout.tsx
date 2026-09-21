"use client"

import type * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { ArrowLeftIcon, CalendarPlusIcon, LayoutDashboardIcon, LogOutIcon, ScanLineIcon, TicketIcon } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ThemeToggle } from "@/components/theme-toggle"
import { hasRole, isPlatformAdmin, logout, organizedEventIds, scannableEventIds, useRefreshSession, useSession } from "@/lib/auth"

/**
 * The organizer shell: its own chrome rather than the storefront header, because
 * this is a workspace, not a shop. Links here are offered, never enforced —
 * every service re-checks the caller's grant itself (ADR-010).
 */
export default function OrganizerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { user, isAuthenticated, isLoading } = useSession()
  const refreshSession = useRefreshSession()

  const canOrganize =
    isPlatformAdmin(user) || hasRole(user, "organizer") || organizedEventIds(user).length > 0
  const canScan = isPlatformAdmin(user) || scannableEventIds(user).length > 0

  if (!isLoading && !isAuthenticated) {
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <Alert className="max-w-md">
          <AlertTitle>Sign in to manage events</AlertTitle>
          <AlertDescription>
            <Button size="sm" className="mt-2" asChild>
              <Link href="/login?next=/organizer">Sign in</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </main>
    )
  }

  if (!isLoading && isAuthenticated && !canOrganize) {
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <Alert className="max-w-md">
          <AlertTitle>This account cannot organize events</AlertTitle>
          <AlertDescription>
            It needs the <code className="font-mono text-xs">organizer</code> role. A platform
            administrator grants it.
            <Button size="sm" variant="outline" className="mt-3" asChild>
              <Link href="/">Back to events</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </main>
    )
  }

  const initials = (user?.fullName ?? "?")
    .split(" ")
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("")

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link href="/organizer">
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <TicketIcon className="size-4" />
                  </div>
                  <div className="flex flex-col leading-none">
                    <span className="font-semibold">Ticketing</span>
                    <span className="text-xs text-muted-foreground">Organizer</span>
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Manage</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={pathname === "/organizer"} tooltip="Overview">
                    <Link href="/organizer">
                      <LayoutDashboardIcon />
                      <span>Overview</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={pathname === "/organizer/new"} tooltip="New event">
                    <Link href="/organizer/new">
                      <CalendarPlusIcon />
                      <span>New event</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {canScan && (
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip="Gate scanner">
                      <Link href="/scan">
                        <ScanLineIcon />
                        <span>Gate scanner</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Back to the site">
                    <Link href="/">
                      <ArrowLeftIcon />
                      <span>Back to the site</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                tooltip="Sign out"
                onClick={() => {
                  void logout().then(() => {
                    refreshSession()
                    router.push("/")
                  })
                }}
              >
                <Avatar className="size-8">
                  <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                </Avatar>
                <div className="flex flex-col leading-none">
                  <span className="truncate text-sm font-medium">{user?.fullName ?? "…"}</span>
                  <span className="truncate text-xs text-muted-foreground">{user?.email ?? ""}</span>
                </div>
                <LogOutIcon className="ml-auto size-4" />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mx-1 h-5" />
          <span className="text-sm font-medium">
            {pathname === "/organizer/new" ? "New event" : pathname.startsWith("/organizer/events/") ? "Event" : "Overview"}
          </span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <main className="flex flex-1 flex-col gap-6 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
