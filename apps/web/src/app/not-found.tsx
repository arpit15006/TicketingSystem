import Link from "next/link"
import { CompassIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-24">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CompassIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing here</EmptyTitle>
          <EmptyDescription>
            That page doesn&apos;t exist. It may have been an event that finished.
          </EmptyDescription>
        </EmptyHeader>
        <Button asChild>
          <Link href="/">Browse events</Link>
        </Button>
      </Empty>
    </main>
  )
}
