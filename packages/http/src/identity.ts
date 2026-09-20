import type { FastifyRequest } from 'fastify';
import { unauthorized } from './errors.js';

export const DEV_USER_HEADER = 'x-dev-user-id';

/**
 * Resolves the calling user.
 *
 * A verified RS256 token always wins. The `x-dev-user-id` header is a Phase 1
 * scaffold from before the identity service existed: it is *attribution*, not
 * authorization — no permission is ever granted from it, and `requirePermission`
 * ignores it entirely, so a caller using it has no roles and can do nothing that
 * needs one.
 *
 * It stays env-gated rather than deleted so that switching it off is a visible,
 * testable event. Production sets ALLOW_DEV_IDENTITY_HEADER=false.
 */
export function devIdentityEnabled(): boolean {
  return (process.env['ALLOW_DEV_IDENTITY_HEADER'] ?? 'false') === 'true';
}

export function requireUserId(req: FastifyRequest): string {
  if (req.auth !== null && req.auth !== undefined) return req.auth.userId;

  const raw = req.headers[DEV_USER_HEADER];
  const headerValue = (Array.isArray(raw) ? raw[0] : raw)?.trim();

  if (devIdentityEnabled() && headerValue !== undefined && headerValue !== '') {
    return headerValue;
  }
  throw unauthorized('No authenticated user on request');
}
