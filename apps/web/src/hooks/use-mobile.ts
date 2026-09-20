import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * A media query is an external store, so it is read with the hook React provides
 * for external stores rather than mirrored into state from an effect.
 *
 * The generated version set state inside an effect to seed the initial value,
 * which renders once with the wrong answer and then again with the right one —
 * a visible flash on the seat page, where the basket moves between a sheet and a
 * sidebar. `useSyncExternalStore` reads the true value during the first client
 * render instead, and `react-hooks/set-state-in-effect` stops firing.
 */
function subscribe(onStoreChange: () => void): () => void {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onStoreChange)
  return () => mql.removeEventListener("change", onStoreChange)
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    // There is no viewport during a server render. Assume desktop; the first
    // client render corrects it before paint.
    () => false
  )
}
