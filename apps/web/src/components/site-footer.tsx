import Link from "next/link"
import { Wordmark } from "@/components/logo"
import { Separator } from "@/components/ui/separator"

const COLUMNS: { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: "Explore",
    links: [
      { label: "All events", href: "/" },
      { label: "Prove it never oversells", href: "/proof" },
      { label: "My bookings", href: "/bookings" },
    ],
  },
  {
    heading: "Organizers",
    links: [
      { label: "Organizer dashboard", href: "/organizer" },
      { label: "Create an event", href: "/organizer/new" },
      { label: "Gate scanner", href: "/scan" },
    ],
  },
  {
    heading: "Help",
    links: [
      { label: "How booking works", href: "/help" },
      { label: "Terms", href: "/terms" },
    ],
  },
]

export function SiteFooter() {
  return (
    <footer className="border-t bg-muted/30 print:hidden">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-3">
            <Wordmark className="text-lg" />
            <p className="max-w-xs text-sm text-muted-foreground">
              Seats are held while you pay and never sold twice — a guarantee we test, not promise.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <nav key={col.heading} className="flex flex-col gap-2 text-sm" aria-label={col.heading}>
              <h4 className="font-medium">{col.heading}</h4>
              {col.links.map((l) => (
                <Link key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">
                  {l.label}
                </Link>
              ))}
            </nav>
          ))}
        </div>
        <Separator />
        <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Payments in Razorpay test mode. No real money moves.</span>
          <span>Postgres · Kafka · Redis · Next.js — every hold is a conditional UPDATE.</span>
        </div>
      </div>
    </footer>
  )
}
