"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { api } from "./api"
import type {
  AvailabilityResponse,
  EventDetail,
  EventStatus,
  EventSummary,
  SalesSummary,
} from "./api-types"

export function useEvents(status?: EventStatus): UseQueryResult<EventSummary[]> {
  return useQuery({
    queryKey: ["events", status ?? "all"],
    queryFn: async () => {
      const query = status === undefined ? "" : `?status=${status}`
      const result = await api<{ events: EventSummary[] }>(`/catalog/events${query}`)
      return result.events
    },
  })
}

export function useEvent(eventId: string): UseQueryResult<EventDetail> {
  return useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => api<EventDetail>(`/catalog/events/${eventId}`),
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
