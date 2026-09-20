"use client"

import * as React from "react"
import { cn } from "cn"
import type { AvailableSeat, EventDetail, SeatTier } from "@/lib/api-types"
import { formatPaise } from "@/lib/format"

/**
 * PRD §13 — **SVG, not canvas.** Every seat is a real element, so hit detection
 * is the browser's job and each seat can carry its own accessible name. A canvas
 * would need hand-rolled hit testing and would be invisible to a screen reader.
 *
 * The seatmap is assembled from two services, which is the whole point of the
 * read/write split in PRD §4:
 *
 *   geometry  ← catalog     (how many rows, how many seats, which tier)
 *   free seats ← reservation (which of them you can actually buy)
 *
 * Catalog may serve geometry from a five-second cache; it has no opinion about
 * seat state. Reservation is asked which seats are free, and a seat it does not
 * return is not free — so anything without a seat id renders as taken.
 *
 * The join key is `(section, row_label, seat_number)`, because reservation
 * generates rows as `'R' || r` and seats as `s::text` when it provisions
 * inventory (apps/reservation/src/server.ts).
 */

const SEAT = 14
const GAP = 4
const PITCH = SEAT + GAP
const ROW_LABEL_WIDTH = 28
const SECTION_GAP = 36

export interface SeatCell {
  key: string
  seatId: string | null
  section: string
  rowLabel: string
  seatNumber: string
  tierId: string
}

export const seatKey = (section: string, rowLabel: string, seatNumber: string): string =>
  `${section}|${rowLabel}|${seatNumber}`

export interface SeatmapProps {
  event: EventDetail
  availableSeats: AvailableSeat[]
  selected: Set<string>
  /** Seats a 409 just told us went to someone else — greyed and briefly flagged. */
  lostSeatIds?: Set<string>
  disabled?: boolean
  onToggle: (cell: SeatCell) => void
}

export function Seatmap({
  event,
  availableSeats,
  selected,
  lostSeatIds,
  disabled = false,
  onToggle,
}: SeatmapProps) {
  // Only free seats come back from /availability, so presence in this map IS
  // availability. Absence means sold, held by someone else, or never existed.
  const freeSeats = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const seat of availableSeats) {
      map.set(seatKey(seat.section, seat.row_label, seat.seat_number), seat.seat_id)
    }
    return map
  }, [availableSeats])

  const tiersById = React.useMemo(() => {
    const map = new Map<string, SeatTier>()
    for (const tier of event.tiers) map.set(tier.tier_id, tier)
    return map
  }, [event.tiers])

  const sections = event.sections

  /*
   * Section offsets are computed once, up front. Accumulating a `let` while
   * mapping over sections mutates a variable during render — React Compiler
   * rejects it, and rightly: the value would carry over between renders.
   */
  const layout = React.useMemo(
    () =>
      sections.map((section, index) => ({
        section,
        top: sections
          .slice(0, index)
          .reduce((offset, above) => offset + above.row_count * PITCH + SECTION_GAP, 0),
      })),
    [sections]
  )

  if (sections.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This event has no seatmap yet.
      </p>
    )
  }

  const widest = Math.max(...sections.map((s) => s.seats_per_row))
  const width = ROW_LABEL_WIDTH + widest * PITCH + 8
  const height =
    sections.reduce((total, s) => total + s.row_count * PITCH + SECTION_GAP, 0) + 8

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="group"
      aria-label={`Seatmap for ${event.title}`}
    >
      {layout.map(({ section, top: sectionTop }) => {
        const tier = tiersById.get(section.tier_id)

        return (
          <g key={section.section_id}>
            <text
              x={0}
              y={sectionTop + 12}
              className="fill-muted-foreground text-[10px] font-medium"
            >
              {section.name}
              {tier !== undefined ? ` · ${formatPaise(tier.price_paise)}` : ""}
            </text>

            {Array.from({ length: section.row_count }, (_, rowIndex) => {
              const rowLabel = `R${rowIndex + 1}`
              const y = sectionTop + 20 + rowIndex * PITCH

              return (
                <g key={rowLabel}>
                  <text
                    x={0}
                    y={y + SEAT - 3}
                    className="fill-muted-foreground text-[8px] tabular-nums"
                  >
                    {rowIndex + 1}
                  </text>

                  {Array.from({ length: section.seats_per_row }, (_, seatIndex) => {
                    const seatNumber = String(seatIndex + 1)
                    const key = seatKey(section.name, rowLabel, seatNumber)
                    const seatId = freeSeats.get(key) ?? null
                    const isSelected = seatId !== null && selected.has(seatId)
                    const isLost = seatId !== null && lostSeatIds?.has(seatId) === true
                    const isTaken = seatId === null

                    const cell: SeatCell = {
                      key,
                      seatId,
                      section: section.name,
                      rowLabel,
                      seatNumber,
                      tierId: section.tier_id,
                    }

                    return (
                      <rect
                        key={seatNumber}
                        x={ROW_LABEL_WIDTH + seatIndex * PITCH}
                        y={y}
                        width={SEAT}
                        height={SEAT}
                        rx={3}
                        tabIndex={isTaken || disabled ? -1 : 0}
                        role="checkbox"
                        aria-checked={isSelected}
                        aria-disabled={isTaken || disabled}
                        aria-label={`${section.name} row ${rowIndex + 1} seat ${seatNumber}${
                          isTaken ? ", unavailable" : tier === undefined ? "" : `, ${formatPaise(tier.price_paise)}`
                        }`}
                        className={cn(
                          "transition-colors",
                          isTaken
                            ? "fill-muted stroke-border"
                            : isSelected
                              ? "fill-primary stroke-primary cursor-pointer"
                              : "fill-emerald-500/25 stroke-emerald-500/60 hover:fill-emerald-500/50 cursor-pointer",
                          isLost && "fill-destructive/40 stroke-destructive",
                          disabled && !isSelected && "cursor-not-allowed opacity-60"
                        )}
                        strokeWidth={1}
                        onClick={() => {
                          if (isTaken || disabled) return
                          onToggle(cell)
                        }}
                        onKeyDown={(e) => {
                          if (isTaken || disabled) return
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            onToggle(cell)
                          }
                        }}
                      />
                    )
                  })}
                </g>
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}

export function SeatmapLegend() {
  const swatch = "inline-block size-3 rounded-[3px] border align-middle"
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className={cn(swatch, "border-emerald-500/60 bg-emerald-500/25")} /> Available
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn(swatch, "border-primary bg-primary")} /> Selected
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn(swatch, "border-border bg-muted")} /> Taken
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn(swatch, "border-destructive bg-destructive/40")} /> Just lost
      </span>
    </div>
  )
}
