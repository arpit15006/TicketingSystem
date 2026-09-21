/**
 * Money arrives from the services in paise and is never converted before it gets
 * here. Integer paise is the only representation the backend stores or compares,
 * so the rupee value exists for display and nothing else — never round-trip a
 * formatted string back into a request.
 */
/**
 * Coerce a paise value arriving from the wire.
 *
 * `price_paise` and `amount_paise` are BIGINT, which node-postgres serialises as
 * a **string**. Catalog and orders both normalise before responding, so this is
 * belt-and-braces — but trusting the wire is exactly how three ₹2,500 seats once
 * rendered as ₹2,50,00,02,50,00,02,500, and a declared TypeScript type is not a
 * runtime guarantee for unvalidated JSON.
 */
export function toPaise(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function formatPaise(paise: number | string): string {
  const value = toPaise(paise)
  return formatRupees(value)
}

function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: paise % 100 === 0 ? 0 : 2,
  }).format(paise / 100)
}

export function formatEventDate(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/**
 * `Sun, 19 Oct, 6:00 PM` — the listing card's date line, which leads the card.
 *
 * `en-IN` already produces this shape; only the day period comes back lowercase,
 * so it is rebuilt from parts rather than regex-cased. A naive `.toUpperCase()`
 * on the whole string would shout the month too, and an `/am|pm/` replace would
 * also hit the "am" inside a month or weekday name in other locales.
 */
export function formatCardDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso))

  return parts
    .map((part) => (part.type === "dayPeriod" ? part.value.toUpperCase() : part.value))
    .join("")
}

/** `mm:ss`, for the hold countdown. */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}
