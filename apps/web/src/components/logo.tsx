import { cn } from "cn"

/** The mark: a ticket stub with a notch. Inline SVG so it inherits `currentColor`. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-6", className)} fill="none">
      <path
        d="M6 9a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v4.2a2.8 2.8 0 0 0 0 5.6V23a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3v-4.2a2.8 2.8 0 0 0 0-5.6V9Z"
        fill="currentColor"
      />
      <path d="M13 11v10M19 11v10" stroke="var(--background)" strokeWidth="2" strokeLinecap="round" strokeDasharray="1.5 2.5" />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 font-semibold tracking-tight", className)}>
      <LogoMark />
      <span>Ticketing</span>
    </span>
  )
}
