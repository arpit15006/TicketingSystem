"use client"

/** The subset of Razorpay Checkout this app uses. */
export interface RazorpayHandlerResponse {
  razorpay_order_id: string
  razorpay_payment_id: string
  razorpay_signature: string
}

interface RazorpayOptions {
  key: string
  amount: number
  currency: string
  order_id: string
  name: string
  description?: string
  handler: (response: RazorpayHandlerResponse) => void
  modal?: { ondismiss?: () => void }
  prefill?: { name?: string; email?: string }
  theme?: { color?: string }
}

interface RazorpayInstance {
  open: () => void
  on: (event: string, handler: (payload: unknown) => void) => void
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance
  }
}

const SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js"

let loader: Promise<void> | null = null

/** Loads Razorpay Checkout once, no matter how many times it is asked for. */
export function loadRazorpay(): Promise<void> {
  if (window.Razorpay !== undefined) return Promise.resolve()
  if (loader !== null) return loader

  loader = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script")
    script.src = SCRIPT_SRC
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      loader = null
      reject(new Error("Could not load Razorpay Checkout"))
    }
    document.head.appendChild(script)
  })

  return loader
}

export function openRazorpay(options: RazorpayOptions): void {
  const Constructor = window.Razorpay
  if (Constructor === undefined) throw new Error("Razorpay Checkout is not loaded")
  new Constructor(options).open()
}
