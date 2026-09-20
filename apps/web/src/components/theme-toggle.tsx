"use client"

import { useTheme } from "next-themes"
import { MoonIcon, SunIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * No `mounted` flag, and so no state at all.
 *
 * The usual pattern sets state in an effect to avoid a hydration mismatch, which
 * renders the wrong icon once and trips `react-hooks/set-state-in-effect`. There
 * is no need: next-themes puts the resolved theme on `<html>` before paint, so
 * both icons can be rendered and CSS picks the right one. The server and client
 * emit identical markup because the decision is never made in JavaScript.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <SunIcon className="hidden size-4 dark:block" />
      <MoonIcon className="size-4 dark:hidden" />
    </Button>
  )
}
