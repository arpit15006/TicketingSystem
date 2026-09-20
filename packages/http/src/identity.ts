import type { FastifyRequest } from 'fastify';
import { unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

export const DEV_USER_HEADER = 'x-dev-user-id';

/**
 * Phase 1 only.
 *
 * There is no identity service yet, so the caller asserts who it is. This is
 * *attribution*, not authorization — nothing in Phase 1 grants a permission based
 * on it, and the seat-allocation guarantee does not depend on who is asking.
 *
 * Phase 2 replaces this with RS256 verification of the JWT and sets
 * ALLOW_DEV_IDENTITY_HEADER=false, after which this path refuses to run outside
 * tests. It is env-gated rather than deleted so the switch-off is a visible,
 * testable event rather than a silent refactor.
 */
export function devIdentityEnabled(): boolean {
  return (process.env['ALLOW_DEV_IDENTITY_HEADER'] ?? 'true') === 'true';
}

export function requireUserId(req: FastifyRequest): string {
  const raw = req.headers[DEV_USER_HEADER];
  const headerValue = (Array.isArray(raw) ? raw[0] : raw)?.trim();

  if (devIdentityEnabled() && headerValue !== undefined && headerValue !== '') {
    return headerValue;
  }
  throw unauthorized('No authenticated user on request');
}
