/**
 * The date buckets behind the listing's "Today / Tomorrow / This weekend" chips.
 *
 * All arithmetic is on local-midnight boundaries rather than fixed 24-hour
 * offsets from `now`, because "today" means the calendar day a buyer is looking
 * at — at 11pm, `now + 24h` would wrongly call tomorrow night "today".
 */

export type When = "all" | "today" | "tomorrow" | "weekend"

export const WHEN_LABEL: Record<Exclude<When, "all">, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  weekend: "This weekend",
}

const DAY_MS = 86_400_000

function startOfDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * `[inclusiveStart, exclusiveEnd)` in epoch milliseconds, or null for "all".
 *
 * The weekend runs to Monday midnight. Asked on a Saturday or Sunday it means
 * the weekend already in progress, not the next one — a buyer browsing on
 * Saturday afternoon is asking what is on tonight.
 */
export function whenRange(when: When, now: number): [number, number] | null {
  const today = startOfDay(now)

  switch (when) {
    case "all":
      return null
    case "today":
      return [today, today + DAY_MS]
    case "tomorrow":
      return [today + DAY_MS, today + 2 * DAY_MS]
    case "weekend": {
      const weekday = new Date(now).getDay() // 0 Sun … 6 Sat
      if (weekday === 6) return [today, today + 2 * DAY_MS] // Sat → Mon 00:00
      if (weekday === 0) return [today, today + DAY_MS] // Sun → Mon 00:00
      const untilSaturday = 6 - weekday
      return [today + untilSaturday * DAY_MS, today + (untilSaturday + 2) * DAY_MS]
    }
  }
}

export function startsWithin(startsAt: string, range: [number, number] | null): boolean {
  if (range === null) return true
  const at = new Date(startsAt).getTime()
  return at >= range[0] && at < range[1]
}
