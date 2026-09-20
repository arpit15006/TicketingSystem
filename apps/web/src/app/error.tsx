"use client"

import * as React from "react"
import Link from "next/link"
import { TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <>
    <SiteHeader />
    <main className="flex flex-1 items-center justify-center px-4 py-24">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Something broke on this page</EmptyTitle>
          <EmptyDescription>
            Your seats and payments are safe — nothing here touches them. Try again, or head back.
            {error.digest !== undefined && <span className="mt-2 block font-mono text-xs">{error.digest}</span>}
          </EmptyDescription>
        </EmptyHeader>
        <div className="flex gap-2">
          <Button onClick={reset}>Try again</Button>
          <Button variant="outline" asChild>
            <Link href="/">Browse events</Link>
          </Button>
        </div>
      </Empty>
    </main>
    <SiteFooter />
    </>
  )
}
