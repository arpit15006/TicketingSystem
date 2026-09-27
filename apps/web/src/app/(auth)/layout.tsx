import Link from "next/link"
import { LockKeyholeIcon, ShieldCheckIcon, TimerIcon } from "lucide-react"
import { Wordmark } from "@/components/logo"

const CLAIMS = [
  {
    icon: TimerIcon,
    title: "Seats are held while you pay",
    body: "Ten minutes, counted down on screen. The hold expires on its own — nothing sweeps it up later.",
  },
  {
    icon: ShieldCheckIcon,
    title: "A seat is never sold twice",
    body: "Every allocation is one conditional UPDATE. Fire two hundred requests at one seat and exactly one wins.",
  },
  {
    icon: LockKeyholeIcon,
    title: "Charged only once confirmed",
    body: "Payments are authorised first and captured after the seat is yours. Razorpay test mode throughout.",
  },
]

/**
 * Sign-in and registration share one frame: the claim on the left, the form on
 * the right.
 *
 * The dark panel is doing structural work rather than decoration — a heavier
 * surface separating a region, which is what §12 asks a material to signal. It
 * is hidden below `lg`, where a phone has no width to spend on it and the form
 * is the only thing worth showing above the fold.
 */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex min-h-svh flex-1">
      <aside className="relative hidden w-[46%] max-w-2xl flex-col justify-between overflow-hidden bg-(--panel) p-12 text-white lg:flex [--panel:#0a0a0a] dark:[--panel:#2c2c2e] [--background:var(--panel)] dark:border-r">
        {/*
          A faint grid of points, on the scale of the seat maps this app draws.
          It sits under the copy at 8% so it reads as texture, never as content.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle at center, rgb(255 255 255 / 0.09) 1.5px, transparent 1.6px)",
            backgroundSize: "22px 22px",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-transparent via-transparent to-black"
        />

        <Link href="/" className="relative z-10 w-fit">
          <Wordmark className="text-lg text-white" />
        </Link>

        <div className="relative z-10 flex flex-col gap-10">
          <p className="max-w-[14ch] text-5xl leading-[1.1] font-semibold tracking-[-0.021em]">
            Tickets that can only be sold once.
          </p>
          <ul className="flex flex-col gap-6">
            {CLAIMS.map((claim) => (
              <li key={claim.title} className="flex gap-3.5">
                <claim.icon className="mt-0.5 size-5 shrink-0 text-white/70" aria-hidden />
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold">{claim.title}</p>
                  <p className="max-w-[46ch] text-sm leading-relaxed text-white/60">{claim.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 text-xs text-white/40">
          Postgres · Kafka · Redis · Next.js — every hold is a conditional UPDATE.
        </p>
      </aside>

      <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        <div className="flex w-full max-w-sm flex-col gap-8">
          {/* The wordmark the dark panel is carrying on desktop. */}
          <Link href="/" className="w-fit lg:hidden">
            <Wordmark className="text-lg" />
          </Link>
          {children}
        </div>
      </div>
    </main>
  )
}
