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

/**
 * One colour per tier, assigned in tier order. Static class strings on purpose:
 * Tailwind only emits classes it can see at build time, so they cannot be
 * assembled from a hue at runtime.
 */
export const TIER_PALETTE = [
  { seat: "fill-amber-400/30 stroke-amber-500/70 hover:fill-amber-400/60", swatch: "border-amber-500/70 bg-amber-400/30" },
  { seat: "fill-emerald-500/25 stroke-emerald-500/60 hover:fill-emerald-500/50", swatch: "border-emerald-500/60 bg-emerald-500/25" },
  { seat: "fill-sky-400/25 stroke-sky-500/60 hover:fill-sky-400/50", swatch: "border-sky-500/60 bg-sky-400/25" },
  { seat: "fill-violet-400/25 stroke-violet-500/60 hover:fill-violet-400/50", swatch: "border-violet-500/60 bg-violet-400/25" },
  { seat: "fill-rose-400/25 stroke-rose-500/60 hover:fill-rose-400/50", swatch: "border-rose-500/60 bg-rose-400/25" },
] as const

export function tierPalette(index: number) {
  return TIER_PALETTE[index % TIER_PALETTE.length] ?? TIER_PALETTE[0]
}
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

/** What the floating tooltip shows for the seat under the pointer. */
export interface HoverInfo {
  seatId: string | null
  section: string
  rowLabel: string
  seatNumber: string
  tierName: string
  pricePaise: number
  taken: boolean
  clientX: number
  clientY: number
}

export interface SeatmapProps {
  event: EventDetail
  availableSeats: AvailableSeat[]
  selected: Set<string>
  /** Seats a 409 just told us went to someone else — greyed and briefly flagged. */
  lostSeatIds?: Set<string>
  /** When set, sections of other tiers are dimmed and not clickable. */
  onlyTierId?: string | null
  disabled?: boolean
  onToggle: (cell: SeatCell) => void
  onHover?: (info: HoverInfo | null) => void
}

/**
 * "Best available": `count` free seats together in one row, as close to the
 * stage as possible (lowest row index), optionally within one tier. Returns
 * seat ids, or an empty list when no row has a long enough run.
 *
 * Pure: it reads the same geometry + availability the map renders, so what it
 * picks is exactly what the map would show as free.
 */
export function findBestSeats(
  event: EventDetail,
  availableSeats: AvailableSeat[],
  count: number,
  onlyTierId: string | null = null
): string[] {
  const free = new Map<string, string>()
  for (const seat of availableSeats) free.set(seatKey(seat.section, seat.row_label, seat.seat_number), seat.seat_id)

  const widest = Math.max(1, ...event.sections.map((s) => s.seats_per_row))
  // Sections are laid out top to bottom in catalog order, first nearest the
  // stage — so "closest to the stage" is section order first, then row.
  let best: { sectionIndex: number; rowIndex: number; centre: number; ids: string[] } | null = null

  for (const [sectionIndex, section] of event.sections.entries()) {
    if (onlyTierId !== null && section.tier_id !== onlyTierId) continue
    for (let r = 0; r < section.row_count; r += 1) {
      const rowLabel = `R${r + 1}`
      let run: string[] = []
      for (let c = 0; c < section.seats_per_row; c += 1) {
        const id = free.get(seatKey(section.name, rowLabel, String(c + 1)))
        if (id === undefined) {
          run = []
          continue
        }
        run.push(id)
        if (run.length === count) {
          // Prefer the front, then the middle of the row.
          const centre = Math.abs((c - count / 2) - section.seats_per_row / 2) / widest
          const better =
            best === null ||
            sectionIndex < best.sectionIndex ||
            (sectionIndex === best.sectionIndex && (r < best.rowIndex || (r === best.rowIndex && centre < best.centre)))
          if (better) best = { sectionIndex, rowIndex: r, centre, ids: [...run] }
          run.shift()
        }
      }
    }
  }
  return best?.ids ?? []
}

export function Seatmap({
  event,
  availableSeats,
  selected,
  lostSeatIds,
  onlyTierId = null,
  disabled = false,
  onToggle,
  onHover,
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
    const map = new Map<string, SeatTier & { paletteIndex: number }>()
    event.tiers.forEach((tier, index) => map.set(tier.tier_id, { ...tier, paletteIndex: index }))
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
        top:
          34 +
          sections
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
  const STAGE = 34
  const height =
    STAGE + sections.reduce((total, s) => total + s.row_count * PITCH + SECTION_GAP, 0) + 8

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="group"
      aria-label={`Seatmap for ${event.title}`}
      onMouseLeave={() => onHover?.(null)}
    >
      {/* Every venue has a front; the map says where it is. */}
      <rect x={ROW_LABEL_WIDTH} y={0} width={widest * PITCH - GAP} height={18} rx={9} className="fill-foreground/10" />
      <text
        x={ROW_LABEL_WIDTH + (widest * PITCH - GAP) / 2}
        y={13}
        textAnchor="middle"
        className="fill-muted-foreground text-[9px] font-semibold tracking-[0.3em]"
      >
        STAGE
      </text>

      {layout.map(({ section, top: sectionTop }) => {
        const tier = tiersById.get(section.tier_id)

        const dimmed = onlyTierId !== null && section.tier_id !== onlyTierId

        return (
          <g key={section.section_id} className={dimmed ? "opacity-25" : undefined}>
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
                    const inert = isTaken || disabled || dimmed

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
                        tabIndex={inert ? -1 : 0}
                        role="checkbox"
                        aria-checked={isSelected}
                        aria-disabled={inert}
                        aria-label={`${section.name} row ${rowIndex + 1} seat ${seatNumber}${
                          isTaken ? ", unavailable" : tier === undefined ? "" : `, ${formatPaise(tier.price_paise)}`
                        }`}
                        className={cn(
                          "transition-colors",
                          isTaken
                            ? "fill-muted stroke-border"
                            : isSelected
                              ? "fill-primary stroke-primary cursor-pointer"
                              : `${tierPalette(tier?.paletteIndex ?? 0).seat} cursor-pointer`,
                          isLost && "fill-destructive/40 stroke-destructive",
                          disabled && !isSelected && "cursor-not-allowed opacity-60"
                        )}
                        strokeWidth={1}
                        onClick={() => {
                          if (inert) return
                          onToggle(cell)
                        }}
                        onMouseEnter={(e) =>
                          onHover?.({
                            seatId,
                            section: section.name,
                            rowLabel,
                            seatNumber,
                            tierName: tier?.name ?? "",
                            pricePaise: tier?.price_paise ?? 0,
                            taken: isTaken,
                            clientX: e.clientX,
                            clientY: e.clientY,
                          })
                        }
                        onKeyDown={(e) => {
                          if (inert) return
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

export function SeatmapLegend({ tiers }: { tiers: SeatTier[] }) {
  const swatch = "inline-block size-3 rounded-[3px] border align-middle"
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {tiers.map((tier, index) => (
        <span key={tier.tier_id} className="flex items-center gap-1.5">
          <span className={cn(swatch, tierPalette(index).swatch)} />
          {tier.name} · {formatPaise(tier.price_paise)}
        </span>
      ))}
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
