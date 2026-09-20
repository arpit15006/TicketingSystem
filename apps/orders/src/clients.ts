import { SERVICE_TOKEN_HEADER } from '@ticketing/http';

/** The shape reservation returns for an internal hold lookup. */
export interface HoldDetails {
  holdId: string;
  eventId: string;
  userId: string;
  status: string;
  expiresAt: string;
  seats: { seatId: string; tierId: string; status: string }[];
}

export interface FinalizeResult {
  kind: 'sold' | 'seat_lost' | 'not_found';
  soldSeatIds?: string[];
}

export interface ReservationClient {
  getHold: (holdId: string, requestId: string) => Promise<HoldDetails | null>;
  extendHold: (holdId: string, seconds: number, requestId: string) => Promise<boolean>;
  finalize: (holdId: string, orderId: string, requestId: string) => Promise<FinalizeResult>;
}

export function createReservationClient(options: { baseUrl: string; serviceToken: string }): ReservationClient {
  const headers = (requestId: string): Record<string, string> => ({
    'content-type': 'application/json',
    [SERVICE_TOKEN_HEADER]: options.serviceToken,
    // PRD §14 — forward the id on every outbound call, or the trace breaks exactly
    // where a booking crosses a service boundary.
    'x-request-id': requestId,
  });

  return {
    getHold: async (holdId, requestId) => {
      const response = await fetch(`${options.baseUrl}/holds/${holdId}`, { headers: headers(requestId) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`reservation getHold failed: HTTP ${response.status}`);
      return (await response.json()) as HoldDetails;
    },

    extendHold: async (holdId, seconds, requestId) => {
      const response = await fetch(`${options.baseUrl}/holds/${holdId}/extend`, {
        method: 'PATCH',
        headers: headers(requestId),
        body: JSON.stringify({ seconds }),
      });
      return response.ok;
    },

    finalize: async (holdId, orderId, requestId) => {
      const response = await fetch(`${options.baseUrl}/reservations/${holdId}/finalize`, {
        method: 'POST',
        headers: headers(requestId),
        body: JSON.stringify({ orderId }),
      });

      if (response.status === 200) {
        const body = (await response.json()) as { soldSeatIds: string[] };
        return { kind: 'sold', soldSeatIds: body.soldSeatIds };
      }
      // PRD §8.3 — 410 Gone is the signal to compensate (PRD §10.4).
      if (response.status === 410) return { kind: 'seat_lost' };
      if (response.status === 404) return { kind: 'not_found' };
      throw new Error(`reservation finalize failed: HTTP ${response.status}`);
    },
  };
}

export interface CatalogClient {
  getTierPrices: (eventId: string, requestId: string) => Promise<Map<string, number>>;
}

export function createCatalogClient(options: { baseUrl: string }): CatalogClient {
  return {
    /**
     * Prices come from catalog because catalog owns them. Orders deliberately keeps
     * no copy: a stale price cached here would be charged to a real customer.
     */
    getTierPrices: async (eventId, requestId) => {
      const response = await fetch(`${options.baseUrl}/events/${eventId}`, {
        headers: { 'x-request-id': requestId },
      });
      if (!response.ok) throw new Error(`catalog getEvent failed: HTTP ${response.status}`);
      const body = (await response.json()) as { tiers: { tier_id: string; price_paise: string | number }[] };
      return new Map(body.tiers.map((tier) => [tier.tier_id, Number(tier.price_paise)]));
    },
  };
}
