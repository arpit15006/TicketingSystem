/**
 * PRD §8.4 — the `SeatAllocator` interface.
 *
 * One dispatch point, two implementations. The orders service, the waiting room,
 * the Kafka events and the compensation path all sit above this line and require
 * **zero changes** for segmented mode to work — if any of them needed changing,
 * the abstraction would be in the wrong place.
 *
 * Deliberately thin. Both implementations delegate straight to the raw SQL
 * modules, so the conditional UPDATE and the interval overlap check remain the
 * most visible code in the service rather than disappearing behind a strategy.
 */

import type { PoolClient } from 'pg';
import type { AllocationMode } from '@ticketing/contracts';
import { acquireHold, finalizeHold, releaseHold, pickGeneralAdmissionSeats, AVAILABLE_SEATS_SQL } from './allocation.js';
import {
  acquireSegments,
  finalizeSegments,
  releaseSegments,
  SEGMENT_AVAILABILITY_SQL,
  type SegmentSpan,
} from './segments.js';

export interface AcquireRequest {
  client: PoolClient;
  eventId: string;
  userId: string;
  seatIds: string[];
  holdSeconds: number;
  requestId: string | null;
  /** Required in segmented mode, rejected in whole mode (validated by the route). */
  span?: SegmentSpan | undefined;
}

export interface AcquireSuccess {
  holdId: string;
  expiresAt: Date;
  seatIds: string[];
}

export type AcquireOutcome = AcquireSuccess | { shortfall: true; acquired: string[] };

export interface FinalizeOutcome {
  finalized: string[];
  expected: number;
}

export interface SeatAllocator {
  readonly mode: AllocationMode;
  acquire: (request: AcquireRequest) => Promise<AcquireOutcome>;
  finalize: (args: { client: PoolClient; holdId: string; orderId: string; requestId: string | null }) => Promise<FinalizeOutcome>;
  release: (
    client: PoolClient,
    args: { holdId: string; requestId: string | null },
  ) => Promise<{ released: string[]; eventId: string } | null>;
  availability: (
    client: PoolClient,
    args: { eventId: string; limit: number; span?: SegmentSpan | undefined },
  ) => Promise<unknown[]>;
  /** General admission: only whole-seat mode supports "any N from a tier". */
  pickGeneralAdmission?: (
    client: PoolClient,
    args: { eventId: string; tierId: string; quantity: number },
  ) => Promise<string[]>;
}

/** The Phase 1 behaviour, untouched. */
export const wholeSeatAllocator: SeatAllocator = {
  mode: 'whole',

  acquire: async (request) =>
    acquireHold({
      client: request.client,
      eventId: request.eventId,
      userId: request.userId,
      seatIds: request.seatIds,
      holdSeconds: request.holdSeconds,
      requestId: request.requestId,
    }),

  finalize: async (args) => finalizeHold(args),

  release: async (client, args) => releaseHold(client, args),

  availability: async (client, args) => {
    const result = await client.query(AVAILABLE_SEATS_SQL, [args.eventId, args.limit]);
    return result.rows;
  },

  pickGeneralAdmission: async (client, args) => pickGeneralAdmissionSeats(client, args),
};

export const segmentAllocator: SeatAllocator = {
  mode: 'segmented',

  acquire: async (request) => {
    if (request.span === undefined) {
      throw new Error('segmented allocation requires fromStop and toStop');
    }
    return acquireSegments({
      client: request.client,
      eventId: request.eventId,
      userId: request.userId,
      seatIds: request.seatIds,
      span: request.span,
      holdSeconds: request.holdSeconds,
      requestId: request.requestId,
    });
  },

  finalize: async (args) => finalizeSegments(args),

  release: async (client, args) => releaseSegments(client, args),

  availability: async (client, args) => {
    if (args.span === undefined) {
      throw new Error('segmented availability requires fromStop and toStop');
    }
    const result = await client.query(SEGMENT_AVAILABILITY_SQL, [
      args.eventId,
      args.span.fromStop,
      args.span.toStop,
      args.limit,
    ]);
    return result.rows;
  },
};

export function allocatorFor(mode: AllocationMode): SeatAllocator {
  return mode === 'segmented' ? segmentAllocator : wholeSeatAllocator;
}
