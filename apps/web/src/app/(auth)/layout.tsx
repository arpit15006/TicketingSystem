import Link from "next/link"
import { TicketIcon } from "lucide-react"

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-12">
      <Link href="/" className="flex items-center gap-2 font-semibold">
        <TicketIcon className="size-5" />
        Ticketing
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  )
}
