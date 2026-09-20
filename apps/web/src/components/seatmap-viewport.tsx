"use client"

import * as React from "react"
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

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
    drag.current = { startX: e.clientX, startY: e.clientY, originX: view.x, originY: view.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (d === null) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY
    if (!d.moved && Math.hypot(dx, dy) < 5) return
    d.moved = true
    setView((v) => ({ ...v, x: d.originX + dx, y: d.originY + dy }))
  }
  const onPointerUp = (): void => {
    if (drag.current?.moved) swallowClick.current = true
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
    <div className={className}>
      <div className="mb-2 flex items-center justify-end gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="icon" aria-label="Zoom out" onClick={() => zoomBy(0.8)}>
              <MinusIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(view.scale * 100)}%</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="icon" aria-label="Zoom in" onClick={() => zoomBy(1.25)}>
              <PlusIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="icon" aria-label="Reset view" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>
              <MaximizeIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset · drag to pan · ⌘/ctrl + scroll to zoom</TooltipContent>
        </Tooltip>
      </div>

      <div
        className="relative h-[560px] cursor-grab touch-none overflow-hidden rounded-md border bg-muted/30 active:cursor-grabbing"
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
