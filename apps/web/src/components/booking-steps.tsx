import { CheckIcon } from "lucide-react"
import { cn } from "cn"

const STEPS = ["Seats", "Pay", "Ticket"] as const

/** Where the buyer is in the three-step flow. Purely informational. */
export function BookingSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center gap-2 text-sm" aria-label="Booking progress">
      {STEPS.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3
        const done = n < current
        const active = n === current
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-xs font-medium",
                done && "border-primary bg-primary text-primary-foreground",
                active && "border-primary text-primary",
                !done && !active && "border-border text-muted-foreground"
              )}
              aria-current={active ? "step" : undefined}
            >
              {done ? <CheckIcon className="size-3.5" /> : n}
            </span>
            <span className={cn(active ? "font-medium" : "text-muted-foreground")}>{label}</span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border sm:w-10" />}
          </li>
        )
      })}
    </ol>
  )
}
