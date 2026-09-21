"use client"

import { Button } from "@/components/ui/button"

/**
 * A filter chip, shared by the home page and the events listing.
 *
 * The shared Button, not a bespoke one. Hand-rolled chips were two more button
 * styles on pages that already had enough, and — worse — they announced no state
 * at all: `aria-pressed` is what tells a screen reader which filter is on.
 */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className="shrink-0"
    >
      {children}
    </Button>
  )
}
