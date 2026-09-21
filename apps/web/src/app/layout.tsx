import type { Metadata } from "next"
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google"
import { Providers } from "@/components/providers"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

/**
 * One display face, for the two places an event's name is the whole point: the
 * printed ticket's hero and its stubs. Everything else stays on Geist — a serif
 * used for labels and numbers is how a ticket starts looking like a receipt.
 */
const instrumentSerif = Instrument_Serif({
  variable: "--font-display",
  weight: "400",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: { default: "Ticketing", template: "%s · Ticketing" },
  description: "Concerts, comedy, sport and theatre. Seats held while you pay, never oversold.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "Ticketing",
    description: "Seats held while you pay, never oversold.",
    type: "website",
    siteName: "Ticketing",
  },
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}
      // next-themes writes the class on <html> before paint; without this React
      // complains about the attribute it did not render.
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
