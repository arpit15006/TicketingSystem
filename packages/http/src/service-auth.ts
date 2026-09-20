import { timingSafeEqual } from 'node:crypto';
import type { preHandlerAsyncHookHandler } from 'fastify';
import { ErrorCode } from '@ticketing/contracts';
import { AppError } from './errors.js';

export const SERVICE_TOKEN_HEADER = 'x-internal-token';

/** Constant-time compare, so a wrong token cannot be found one byte at a time. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Guards endpoints that only another service may call — seat finalization, hold
 * extension, hold lookup.
 *
 * These are deliberately NOT reachable with an end-user token. Finalization turns a
 * hold into a sold seat and is the step that must happen *after* payment is
 * authorized; a user who could call it directly could take a seat without paying.
 * So the caller must prove it is the orders service, not merely that it is signed in.
 *
 * A shared secret is the honest minimum here, and its weakness is worth stating:
 * every holder is equally trusted and rotating it is a coordinated deploy. Real
 * machine identity (mTLS, or client-credentials tokens with per-service audiences)
 * is the upgrade path; this is not it.
 */
export function requireServiceToken(expected: string): preHandlerAsyncHookHandler {
  if (expected === '') {
    throw new Error('INTERNAL_SERVICE_TOKEN must be configured before internal routes are registered');
  }

  return async function serviceTokenCheck(req): Promise<void> {
    const raw = req.headers[SERVICE_TOKEN_HEADER];
    const presented = (Array.isArray(raw) ? raw[0] : raw)?.trim();

    if (presented === undefined || presented === '' || !tokensMatch(presented, expected)) {
      req.log.warn({ route: req.url }, 'internal route called without a valid service token');
      throw new AppError(401, ErrorCode.unauthorized, 'This endpoint requires a valid internal service token');
    }
  };
}
