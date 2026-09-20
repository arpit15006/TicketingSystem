import { jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import { AppError } from '@ticketing/http';
import { ErrorCode } from '@ticketing/contracts';

export const ADMISSION_TOKEN_HEADER = 'x-admission-token';

interface CachedPolicy {
  waitingRoomEnabled: boolean;
  expiresAt: number;
}

export interface AdmissionOptions {
  catalogUrl: string;
  admissionTokenSecret: string;
  /** Short — an organizer toggling the waiting room should take effect quickly. */
  policyCacheMs?: number;
}

/**
 * PRD §12 — waiting-room enforcement for `/reservations`.
 *
 * Enforced here, in the service that owns the seat, and not only at the gateway:
 * the gateway cannot see which event a booking is for without parsing the request
 * body, and a check that can be skipped by reaching the service directly is not a
 * check at all (ADR-010).
 *
 * Every failure mode of this check is FAIL OPEN. The waiting room shapes traffic;
 * it does not protect a seat. If catalog is unreachable, or Redis is down, or the
 * waiting room is broken, the worst outcome must be a thundering herd — which the
 * conditional UPDATE handles correctly anyway — and never a customer who cannot buy
 * a ticket (ADR-012, INV-7).
 */
export function createAdmissionGuard(options: AdmissionOptions) {
  const cacheMs = options.policyCacheMs ?? 5_000;
  const policyCache = new Map<string, CachedPolicy>();
  const secret = new TextEncoder().encode(options.admissionTokenSecret);

  async function waitingRoomEnabled(eventId: string, requestId: string): Promise<boolean> {
    const cached = policyCache.get(eventId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.waitingRoomEnabled;

    try {
      const response = await fetch(`${options.catalogUrl}/events/${eventId}`, {
        headers: { 'x-request-id': requestId },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return false;

      const body = (await response.json()) as { waiting_room_enabled?: boolean };
      const enabled = body.waiting_room_enabled === true;
      policyCache.set(eventId, { waitingRoomEnabled: enabled, expiresAt: Date.now() + cacheMs });
      return enabled;
    } catch {
      // Catalog unreachable — fail open rather than block every booking.
      return false;
    }
  }

  return async function enforceAdmission(req: FastifyRequest, args: { eventId: string; userId: string }): Promise<void> {
    if (!(await waitingRoomEnabled(args.eventId, req.requestId))) return;

    const raw = req.headers[ADMISSION_TOKEN_HEADER];
    const token = (Array.isArray(raw) ? raw[0] : raw)?.trim();

    if (token === undefined || token === '') {
      throw new AppError(403, ErrorCode.forbidden, 'This event requires a waiting-room admission token', {
        eventId: args.eventId,
      });
    }

    try {
      const { payload } = await jwtVerify(token, secret, { issuer: 'waitingroom', audience: 'ticketing' });

      // An admission token for one event must not open another, and one issued to
      // a different user must not be transferable.
      if (payload['eventId'] !== args.eventId) {
        throw new AppError(403, ErrorCode.forbidden, 'Admission token is for a different event');
      }
      if (payload.sub !== args.userId) {
        throw new AppError(403, ErrorCode.forbidden, 'Admission token was issued to a different user');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(403, ErrorCode.forbidden, 'Admission token is invalid or expired');
    }
  };
}
