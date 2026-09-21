"use client"

import * as React from "react"
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "cn"

const MIN = 0.5
const MAX = 4

/**
 * Zoom and pan for the seatmap: buttons, ctrl/⌘+wheel and pinch (browsers send
 * pinch as ctrl+wheel), and drag to pan. A drag that moved more than a few
 * pixels swallows the click that ends it, so panning never selects a seat.
 *
 * The transform is CSS on a wrapper, not an SVG viewBox change, so the 5,000
 * seat elements are never re-laid-out — only composited.
 */
export function SeatmapViewport({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const [view, setView] = React.useState({ scale: 1, x: 0, y: 0 })
  const drag = React.useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null)
  const swallowClick = React.useRef(false)

  const zoomBy = (factor: number): void =>
    setView((v) => ({ ...v, scale: Math.min(MAX, Math.max(MIN, v.scale * factor)) }))

  const onWheel = (e: React.WheelEvent): void => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    zoomBy(e.deltaY < 0 ? 1.1 : 0.9)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    /*
     * NO pointer capture here.
     *
     * Capturing on pointerdown retargets every later pointer event to this
     * container, so the browser fires `click` on the container instead of the
     * seat under the cursor — and selecting a seat with a real mouse silently
     * stopped working. Capture is only needed once a drag is actually under
     * way, so it is taken in pointermove below.
     */
    drag.current = { startX: e.clientX, startY: e.clientY, originX: view.x, originY: view.y, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (d === null) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 5) return
      d.moved = true
      // Now it is a drag: hold the pointer so panning survives leaving the box.
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    setView((v) => ({ ...v, x: d.originX + dx, y: d.originY + dy }))
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.moved === true) {
      swallowClick.current = true
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    }
    drag.current = null
  }
  const onClickCapture = (e: React.MouseEvent): void => {
    if (swallowClick.current) {
      e.stopPropagation()
      e.preventDefault()
      swallowClick.current = false
    }
  }

  return (
    /*
     * The controls sit INSIDE the map's bordered box, as its toolbar.
     * Floating above it in their own row, they read as a stray cluster between
     * the filters and the map — anchored to the thing they control, they do not.
     */
    <div className={cn("overflow-hidden rounded-md border bg-muted/30", className)}>
      <div className="flex items-center justify-end gap-1 border-b bg-background/60 px-2 py-1.5">
        <span className="mr-auto text-xs text-muted-foreground">Drag to pan · ⌘/ctrl + scroll to zoom</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
              <MinusIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(view.scale * 100)}%</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
              <PlusIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Reset view" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>
              <MaximizeIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset view</TooltipContent>
        </Tooltip>
      </div>

      <div
        className="relative h-[520px] cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
      >
        <div
          className="origin-top-left p-4 will-change-transform"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
