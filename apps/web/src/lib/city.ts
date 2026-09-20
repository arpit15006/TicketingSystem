"use client"

import * as React from "react"

/**
 * The viewer's city, like the selector in every ticketing app's header.
 *
 * A per-viewer convenience, so it lives in localStorage and nowhere else: it
 * never reaches a request, and a wiped browser just means "All cities" again.
 * Read through useSyncExternalStore so the header and the listing agree without
 * mirroring it into state.
 */
const KEY = "ticketing.city"
const EVENT = "ticketing:city"

export const ALL_CITIES = "all"

export function getCity(): string {
  if (typeof window === "undefined") return ALL_CITIES
  try {
    return window.localStorage.getItem(KEY) ?? ALL_CITIES
  } catch {
    return ALL_CITIES
  }
}

export function setCity(city: string): void {
  try {
    if (city === ALL_CITIES) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, city)
  } catch {
    // Not persisted; still broadcast so this tab updates.
  }
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange)
  window.addEventListener("storage", onChange)
  return () => {
    window.removeEventListener(EVENT, onChange)
    window.removeEventListener("storage", onChange)
  }
}

export function useCity(): [string, (city: string) => void] {
  const city = React.useSyncExternalStore(subscribe, getCity, () => ALL_CITIES)
  return [city, setCity]
}
