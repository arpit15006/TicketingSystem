import type { AllocationMode } from '@ticketing/contracts';

export interface EventPolicy {
  waitingRoomEnabled: boolean;
  allocationMode: AllocationMode;
  routeId: string | null;
  stopCount: number;
  /**
   * Catalog's word on whether the event is selling. `null` means catalog did not
   * say — unreachable, or an older response without the field — and the caller
   * must treat that as "allow": the status gate is sales policy, not seat
   * correctness, and a catalog outage must not stop a sale (INV-7's spirit).
   */
  status: 'draft' | 'published' | 'onsale' | 'closed' | null;
}

interface Cached {
  policy: EventPolicy;
  expiresAt: number;
}

/**
 * Reservation needs two facts that catalog owns: whether an event has a waiting
 * room, and how its seats are allocated. Both are fetched together and cached for
 * a few seconds.
 *
 * FAILS OPEN and FAILS SAFE. If catalog cannot be reached, the answer is the
 * conservative one — no waiting room (so nobody is blocked from buying) and
 * whole-seat allocation (the mode that cannot be wrong for an event that has
 * never been segmented). An allocation decision is never blocked on catalog being
 * up; INV-7's spirit applies to service dependencies too.
 */
export function createEventPolicyLoader(options: { catalogUrl: string; cacheMs?: number }) {
  const cacheMs = options.cacheMs ?? 5_000;
  const cache = new Map<string, Cached>();

  const fallback: EventPolicy = {
    waitingRoomEnabled: false,
    allocationMode: 'whole',
    routeId: null,
    stopCount: 0,
    status: null,
  };

  return async function loadPolicy(eventId: string, requestId: string): Promise<EventPolicy> {
    const cached = cache.get(eventId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.policy;

    try {
      const response = await fetch(`${options.catalogUrl}/events/${eventId}`, {
        headers: { 'x-request-id': requestId },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return fallback;

      const body = (await response.json()) as {
        waiting_room_enabled?: boolean;
        allocation_mode?: string;
        route_id?: string | null;
        stops?: unknown[];
        status?: string;
      };

      const policy: EventPolicy = {
        waitingRoomEnabled: body.waiting_room_enabled === true,
        allocationMode: body.allocation_mode === 'segmented' ? 'segmented' : 'whole',
        routeId: body.route_id ?? null,
        stopCount: Array.isArray(body.stops) ? body.stops.length : 0,
        status:
          body.status === 'draft' || body.status === 'published' || body.status === 'onsale' || body.status === 'closed'
            ? body.status
            : null,
      };

      cache.set(eventId, { policy, expiresAt: Date.now() + cacheMs });
      return policy;
    } catch {
      return fallback;
    }
  };
}
