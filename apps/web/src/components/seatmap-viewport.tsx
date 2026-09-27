"use client"

import * as React from "react"
import { animate } from "motion"
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "cn"

const MIN_SCALE = 0.5
const MAX_SCALE = 4
const DRAG_THRESHOLD = 5

/**
 * Apple's projection function from *Designing Fluid Interfaces* — where a flick
 * would come to rest if it decelerated like a scroll. Not the textbook
 * v²/(2a): the exponential-decay form is what actually ships, and it is what
 * makes a throw feel thrown rather than teleported.
 */
const project = (velocity: number, decelerationRate = 0.998): number =>
  ((velocity / 1000) * decelerationRate) / (1 - decelerationRate)

/**
 * Progressive resistance past an edge. A hard stop reads as frozen; resistance
 * that grows the further you pull reads as "responsive, but there is nothing
 * more here".
 */
const rubberband = (overshoot: number, dimension: number, constant = 0.55): number =>
  (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

interface Sample {
  x: number
  y: number
  t: number
}

/**
 * Zoom and pan for the seat map.
 *
 * The pan is the one real gesture in this app, so it is built the way Apple
 * builds one: the content tracks the pointer 1:1, resists at its edges instead
 * of stopping dead, keeps the velocity of the flick that released it, and can
 * be grabbed again mid-flight — the animation is re-targeted from wherever the
 * content actually is on screen, never from where it was heading.
 *
 * Position lives in a ref and is written straight to `transform`, not held in
 * state: a pan is 60 writes a second and none of them need React to re-render
 * the 5,000 seats underneath.
 */
export function SeatmapViewport({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const frameRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)

  const pos = React.useRef({ x: 0, y: 0 })
  const scaleRef = React.useRef(1)
  const [scale, setScale] = React.useState(1)

  const drag = React.useRef<{
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
  } | null>(null)
  const history = React.useRef<Sample[]>([])
  const running = React.useRef<{ stop: () => void }[]>([])
  const swallowClick = React.useRef(false)

  const write = React.useCallback(() => {
    const el = contentRef.current
    if (el === null) return
    el.style.transform = `translate3d(${pos.current.x}px, ${pos.current.y}px, 0) scale(${scaleRef.current})`
  }, [])

  /** How far the content may travel before its edge leaves the frame. */
  const bounds = React.useCallback(() => {
    const frame = frameRef.current
    const content = contentRef.current
    if (frame === null || content === null) return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    const f = frame.getBoundingClientRect()
    // offsetWidth is the untransformed box; the live scale is applied here so
    // the bounds follow the zoom.
    const w = content.offsetWidth * scaleRef.current
    const h = content.offsetHeight * scaleRef.current
    return {
      minX: Math.min(0, f.width - w),
      maxX: 0,
      minY: Math.min(0, f.height - h),
      maxY: 0,
    }
  }, [])

  const stopAnimations = React.useCallback(() => {
    for (const a of running.current) a.stop()
    running.current = []
  }, [])

  /** Settle to `target` carrying the gesture's velocity (§5 velocity handoff). */
  const settle = React.useCallback(
    (axis: "x" | "y", target: number, velocity: number) => {
      const from = pos.current[axis]
      if (Math.abs(from - target) < 0.5 && Math.abs(velocity) < 20) {
        pos.current[axis] = target
        write()
        return
      }
      const reduced =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      if (reduced) {
        pos.current[axis] = target
        write()
        return
      }
      const controls = animate(from, target, {
        type: "spring",
        // Bounce only because a flick preceded this. A pan that was merely let
        // go settles flat; one that was thrown overshoots a little, as a thrown
        // thing does.
        bounce: Math.abs(velocity) > 200 ? 0.18 : 0,
        duration: 0.45,
        velocity,
        onUpdate: (v: number) => {
          pos.current[axis] = v
          write()
        },
      })
      running.current.push(controls)
    },
    [write]
  )

  const zoomTo = React.useCallback(
    (next: number) => {
      stopAnimations()
      const frame = frameRef.current
      const clamped = clamp(next, MIN_SCALE, MAX_SCALE)
      if (frame !== null) {
        // Zoom about the frame's centre, so the seat you were looking at stays
        // roughly where you were looking.
        const f = frame.getBoundingClientRect()
        const ratio = clamped / scaleRef.current
        const cx = f.width / 2
        const cy = f.height / 2
        pos.current.x = cx - (cx - pos.current.x) * ratio
        pos.current.y = cy - (cy - pos.current.y) * ratio
      }
      scaleRef.current = clamped
      setScale(clamped)
      const b = bounds()
      pos.current.x = clamp(pos.current.x, b.minX, b.maxX)
      pos.current.y = clamp(pos.current.y, b.minY, b.maxY)
      write()
    },
    [bounds, stopAnimations, write]
  )

  const reset = React.useCallback(() => {
    stopAnimations()
    scaleRef.current = 1
    setScale(1)
    pos.current = { x: 0, y: 0 }
    write()
  }, [stopAnimations, write])

  const onWheel = (e: React.WheelEvent): void => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    zoomTo(scaleRef.current * (e.deltaY < 0 ? 1.1 : 0.9))
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    /*
     * §3 — a moving map must be grabbable. Stopping here leaves the content at
     * its live on-screen position, which is what the next drag starts from; a
     * drag that started from the animation's *target* would jump.
     *
     * No pointer capture yet: capturing now retargets the click to this
     * container and a plain tap would never reach the seat underneath.
     */
    stopAnimations()
    history.current = [{ x: e.clientX, y: e.clientY, t: performance.now() }]
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.current.x,
      originY: pos.current.y,
      moved: false,
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (d === null) return
    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY

    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      d.moved = true
      // Now it is a drag: hold the pointer so the pan survives leaving the box.
      e.currentTarget.setPointerCapture(e.pointerId)
    }

    history.current.push({ x: e.clientX, y: e.clientY, t: performance.now() })
    if (history.current.length > 6) history.current.shift()

    const b = bounds()
    const frame = frameRef.current
    const fw = frame?.clientWidth ?? 1
    const fh = frame?.clientHeight ?? 1

    // §9 — past an edge the content still follows, just less and less.
    const raw = { x: d.originX + dx, y: d.originY + dy }
    pos.current.x =
      raw.x > b.maxX
        ? b.maxX + rubberband(raw.x - b.maxX, fw)
        : raw.x < b.minX
          ? b.minX - rubberband(b.minX - raw.x, fw)
          : raw.x
    pos.current.y =
      raw.y > b.maxY
        ? b.maxY + rubberband(raw.y - b.maxY, fh)
        : raw.y < b.minY
          ? b.minY - rubberband(b.minY - raw.y, fh)
          : raw.y
    write()
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    drag.current = null
    if (d === null || !d.moved) return

    swallowClick.current = true
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }

    // Velocity from the last ~100ms of travel, not from the final two points:
    // one stray sample at release should not decide where the map lands.
    const now = performance.now()
    const recent = history.current.filter((s) => now - s.t < 100)
    let vx = 0
    let vy = 0
    const first = recent[0]
    const last = recent[recent.length - 1]
    if (first !== undefined && last !== undefined && last.t > first.t) {
      const dt = (last.t - first.t) / 1000
      vx = (last.x - first.x) / dt
      vy = (last.y - first.y) / dt
    }

    // §6 — land where the flick was going, then clamp that to the edges.
    const b = bounds()
    settle("x", clamp(pos.current.x + project(vx), b.minX, b.maxX), vx)
    settle("y", clamp(pos.current.y + project(vy), b.minY, b.maxY), vy)
  }

  const onClickCapture = (e: React.MouseEvent): void => {
    if (!swallowClick.current) return
    e.stopPropagation()
    e.preventDefault()
    swallowClick.current = false
  }

  React.useEffect(() => {
    write()
  }, [write])

  return (
    <div className={cn("overflow-hidden rounded-md border bg-muted/30", className)}>
      <div className="flex items-center justify-end gap-1 border-b bg-background/60 px-2 py-1.5">
        <span className="mr-auto text-xs text-muted-foreground">
          Drag to pan · ⌘/ctrl + scroll to zoom
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              onClick={() => zoomTo(scaleRef.current * 0.8)}
            >
              <MinusIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom out</TooltipContent>
        </Tooltip>
        <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              onClick={() => zoomTo(scaleRef.current * 1.25)}
            >
              <PlusIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Zoom in</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Reset view" onClick={reset}>
              <MaximizeIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset view</TooltipContent>
        </Tooltip>
      </div>

      <div
        ref={frameRef}
        className="relative h-[520px] cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
      >
        <div ref={contentRef} className="origin-top-left p-4 will-change-transform">
          {children}
        </div>
      </div>
    </div>
  )
}
