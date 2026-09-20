/** A one-event .ics file, built client-side and handed to the browser to save. */
export function downloadIcs(args: { title: string; startsAt: string; location: string; url: string; uid: string }): void {
  const start = new Date(args.startsAt)
  const end = new Date(start.getTime() + 3 * 60 * 60 * 1000)
  const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  const escape = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\n/g, "\\n")
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ticketing//EN",
    "BEGIN:VEVENT",
    `UID:${args.uid}@ticketing`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(args.title)}`,
    `LOCATION:${escape(args.location)}`,
    `URL:${args.url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" })
  const href = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = href
  a.download = `${args.title.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase()}.ics`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}
