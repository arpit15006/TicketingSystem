"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { BellIcon, CheckCircle2Icon, CircleAlertIcon, XCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { api } from "@/lib/api"
import { useSession } from "@/lib/auth"
import type { NotificationRow } from "@/lib/api-types"

const SEEN_KEY = "ticketing.notifications.seenAt"

function readSeenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0)
  } catch {
    return 0
  }
}

/**
 * The notification service records what the platform *would* have emailed
 * (PRD §2 — no email infrastructure). This is the in-app inbox for it. "Unread"
 * is a per-viewer convenience kept in localStorage; the server has no read
 * state and does not need one.
 */
export function NotificationsBell() {
  const { isAuthenticated } = useSession()
  const [seenAt, setSeenAt] = React.useState(readSeenAt)

  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => (await api<{ notifications: NotificationRow[] }>("/notifications?limit=20")).notifications,
    enabled: isAuthenticated,
    refetchInterval: 60_000,
  })

  if (!isAuthenticated) return null
  const rows = data ?? []
  const unread = rows.filter((n) => new Date(n.created_at).getTime() > seenAt).length

  const markSeen = (): void => {
    const now = Date.now()
    try {
      localStorage.setItem(SEEN_KEY, String(now))
    } catch {
      // Non-fatal.
    }
    setSeenAt(now)
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && markSeen()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}>
          <BellIcon className="size-4" />
          {unread > 0 && (
            <Badge className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px]">{unread}</Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <DropdownMenuLabel className="px-3 py-2">Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0" />
        <ScrollArea className="max-h-96">
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing yet. Book something!</p>
          ) : (
            <div className="flex flex-col p-1">
              {rows.map((n) => (
                <Item key={n.notification_id} size="sm" className="rounded-md">
                  <ItemMedia variant="icon">
                    {n.kind === "order_confirmed" ? (
                      <CheckCircle2Icon className="text-emerald-500" />
                    ) : n.kind === "order_compensated" ? (
                      <CircleAlertIcon className="text-amber-500" />
                    ) : (
                      <XCircleIcon className="text-destructive" />
                    )}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="line-clamp-1">{n.subject}</ItemTitle>
                    <ItemDescription className="line-clamp-2">{n.body}</ItemDescription>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(n.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                    </span>
                  </ItemContent>
                </Item>
              ))}
            </div>
          )}
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
