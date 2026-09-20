"use client"

import * as React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { ApiError } from "@/lib/api"

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        /*
         * Never retry a request the server *answered*. A 409 means another buyer
         * took the seat and a 410 means the hold expired — retrying either would
         * hammer the allocator with a question already settled, and would show
         * the user a spinner instead of the truth. Transport failures still get
         * one retry.
         */
        retry: (failureCount, error) => {
          if (error instanceof ApiError) return false
          return failureCount < 1
        },
      },
      mutations: { retry: false },
    },
  })
}

let browserQueryClient: QueryClient | undefined

function getQueryClient(): QueryClient {
  // One client per browser session, but a fresh one per server render so two
  // users' data can never share a cache.
  if (typeof window === "undefined") return makeQueryClient()
  browserQueryClient ??= makeQueryClient()
  return browserQueryClient
}

export function Providers({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient()

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <TooltipProvider>
          {children}
          <Toaster richColors position="top-center" />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
