"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { api } from "./api"
import { toPaise } from "./format"
import type {
  AvailabilityResponse,
  EventDetail,
  EventStatus,
  EventSummary,
  SalesSummary,
} from "./api-types"

const normaliseSummary = (event: EventSummary): EventSummary => ({
  ...event,
  min_price_paise: event.min_price_paise === null ? null : toPaise(event.min_price_paise),
})

export function useEvents(status?: EventStatus): UseQueryResult<EventSummary[]> {
  return useQuery({
    queryKey: ["events", status ?? "all"],
    queryFn: async () => {
      const query = status === undefined ? "?limit=200" : `?status=${status}&limit=200`
      const result = await api<{ events: EventSummary[] }>(`/catalog/events${query}`)
      return result.events.map(normaliseSummary)
    },
  })
}

/** The organizer's own events, drafts included. Requires a session. */
export function useMyEvents(enabled: boolean): UseQueryResult<EventSummary[]> {
  return useQuery({
    queryKey: ["events", "mine"],
    queryFn: async () => {
      const result = await api<{ events: EventSummary[] }>("/catalog/events/mine")
      return result.events.map(normaliseSummary)
    },
    enabled,
  })
}

export function useEvent(eventId: string): UseQueryResult<EventDetail> {
  return useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => {
      const event = await api<EventDetail>(`/catalog/events/${eventId}`)
      // Normalised once, here, so no component downstream can add two prices
      // together and get a concatenated string.
      return { ...event, tiers: event.tiers.map((tier) => ({ ...tier, price_paise: toPaise(tier.price_paise) })) }
    },
    enabled: eventId !== "",
  })
}

/**
 * Availability comes from reservation, never from catalog.
 *
 * Catalog owns seatmap *geometry* and may serve it from a five-second cache; it
 * deliberately holds no opinion about seat state (PRD §4, ADR-006). A seatmap
 * that is seconds stale is fine. A seat count that is seconds stale is how two
 * people are told the same seat is free.
 */
export function useAvailability(
  eventId: string,
  options: { limit?: number; refetchMs?: number } = {}
): UseQueryResult<AvailabilityResponse> {
  return useQuery({
    queryKey: ["availability", eventId, options.limit ?? 500],
    queryFn: async () =>
      api<AvailabilityResponse>(
        `/availability?eventId=${eventId}&limit=${options.limit ?? 500}`
      ),
    enabled: eventId !== "",
    // Short, because someone else is buying these seats right now.
    staleTime: 3_000,
    ...(options.refetchMs === undefined ? {} : { refetchInterval: options.refetchMs }),
  })
}

/** Organizer dashboard only — requires an `organizer:event:<id>` grant. */
export function useSalesSummary(eventId: string): UseQueryResult<SalesSummary> {
  return useQuery({
    queryKey: ["sales", eventId],
    queryFn: async () => api<SalesSummary>(`/inventory/${eventId}/sales`),
    enabled: eventId !== "",
    refetchInterval: 5_000,
  })
}
