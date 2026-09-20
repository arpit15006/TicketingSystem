"use client"

import * as React from "react"
import { toast } from "sonner"
import { CheckIcon, Share2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Web Share where the platform has it (phones), copy-to-clipboard everywhere else. */
export function ShareButton({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = React.useState(false)

  const share = async (): Promise<void> => {
    const url = window.location.href
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, text, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setCopied(true)
      toast.success("Link copied")
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // The user dismissed the share sheet, or clipboard was refused. Nothing to say.
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void share()}>
      {copied ? <CheckIcon className="size-4" /> : <Share2Icon className="size-4" />}
      {copied ? "Copied" : "Share"}
    </Button>
  )
}
