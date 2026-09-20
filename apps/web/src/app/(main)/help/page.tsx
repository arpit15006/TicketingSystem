import type { Metadata } from "next"
import Link from "next/link"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"

export const metadata: Metadata = { title: "Help" }

const FAQ: { q: string; a: string }[] = [
  { q: "How long are my seats held?", a: "From the moment you hold them until the timer runs out — typically 8 minutes, set per event. When it ends they go back on sale automatically. Nothing needs to run for that to happen, so a hold can never be stuck." },
  { q: "When is my card charged?", a: "Your payment is authorized at checkout and captured only once the seat is confirmed as yours. If the seat is lost in between — because your hold expired the instant before — the authorization is released. No money moves, so there is nothing to refund and nothing to wait for." },
  { q: "What if two people pick the same seat?", a: "Exactly one of them gets it. The database decides with a single conditional update; there is no lock, no queue and no retry. The one who loses is told which seats went, and keeps the rest of their selection." },
  { q: "Why is there a queue on some events?", a: "For high-demand sales, buyers are admitted in batches so the site stays responsive. Being admitted lets you try for seats — it does not reserve any. If the queue's cache is ever unavailable, everyone is let through; seat allocation is unaffected." },
  { q: "Where are my tickets?", a: "Under My bookings, and on each order page as QR codes — one per seat. Each code admits exactly once; a second scan is refused with the time it was first used." },
  { q: "Can I get a refund?", a: "This is a demonstration platform running in Razorpay test mode; no real money is ever charged. A production deployment would define its refund policy per event." },
]

export default function HelpPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">How booking works</h1>
        <p className="text-muted-foreground">Short answers, and the reasons behind them.</p>
      </div>
      <Accordion type="single" collapsible className="rounded-xl border px-4">
        {FAQ.map((item, i) => (
          <AccordionItem key={i} value={`q${i}`}>
            <AccordionTrigger>{item.q}</AccordionTrigger>
            <AccordionContent className="leading-relaxed text-muted-foreground">{item.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
      <div className="flex gap-2">
        <Button asChild>
          <Link href="/">Browse events</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/proof">See the proof</Link>
        </Button>
      </div>
    </div>
  )
}
