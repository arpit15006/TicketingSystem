import fp from 'fastify-plugin';
import { createRemoteJWKSet, createLocalJWKSet, jwtVerify, type JWTVerifyGetKey, type JWK } from 'jose';
import type { FastifyRequest } from 'fastify';
import { parseGrant, type RoleGrant } from '@ticketing/contracts';
import { unauthorized } from './errors.js';

export interface AuthContext {
  userId: string;
  roles: RoleGrant[];
  jti: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated when a valid RS256 access token was presented; null otherwise. */
    auth: AuthContext | null;
  }
}

export interface AuthPluginOptions {
  /** Identity's JWKS endpoint, e.g. http://identity:3001/.well-known/jwks.json */
  jwksUri?: string | undefined;
  /**
   * A key set held in this process, used instead of fetching one. Identity itself
   * verifies this way: it already holds the public half, and making it HTTP-call
   * its own JWKS endpoint would add a self-dependency that fails whenever the
   * service is reachable on a different address than it thinks it is.
   */
  localJwks?: { keys: JWK[] } | undefined;
  issuer: string;
  audience: string;
  /** Called for every verified token; return true to reject a revoked `jti`. */
  isRevoked?: (jti: string) => Promise<boolean>;
}

/**
 * ADR-010 — **every service verifies the token itself.**
 *
 * The gateway checking the signature does not make a downstream service safe: a
 * service that trusts an upstream header is one misconfigured ingress, one exposed
 * internal port, or one pod-to-pod call away from full compromise. So this plugin
 * runs in the gateway *and* in every service behind it, and no service anywhere
 * reads identity from a header.
 *
 * Authentication only. It answers "who is this?" and never "may they do this?" —
 * that decision belongs to the service that owns the resource (see requirePermission).
 */
export const authPlugin = fp<AuthPluginOptions>((fastify, opts, done) => {
  // jose caches a remote key set and refetches on unknown `kid`, so key rotation
  // needs no redeploy and no restart.
  let jwks: JWTVerifyGetKey;
  if (opts.localJwks !== undefined) {
    jwks = createLocalJWKSet(opts.localJwks);
  } else if (opts.jwksUri !== undefined) {
    /*
     * `cooldownDuration` is the minimum gap between refetches when a token
     * arrives with a `kid` we have not seen.
     *
     * Kept short on purpose. If identity restarts with a different signing key
     * — which happens whenever JWT_PRIVATE_KEY is unset and a keypair is
     * generated at boot — every verifier holds a stale JWKS and rejects
     * perfectly valid tokens until it refetches. A 30-second cooldown turns
     * that into 30 seconds of 401s across the whole platform.
     *
     * The real fix is a stable, configured keypair (which is why production
     * refuses to start without one); this bounds the damage when there is not.
     */
    jwks = createRemoteJWKSet(new URL(opts.jwksUri), { cacheMaxAge: 300_000, cooldownDuration: 5_000 });
  } else {
    throw new Error('authPlugin requires either jwksUri or localJwks');
  }

  fastify.decorateRequest('auth', null);

  fastify.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header === undefined || !header.startsWith('Bearer ')) return;

    const token = header.slice('Bearer '.length).trim();
    if (token === '') return;

    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audience });

      const sub = payload.sub;
      const jti = payload.jti;
      if (typeof sub !== 'string' || typeof jti !== 'string') return;

      if (opts.isRevoked !== undefined && (await opts.isRevoked(jti))) {
        req.log.info({ jti }, 'access token is revoked');
        return;
      }

      const rawRoles = Array.isArray(payload['roles']) ? (payload['roles'] as unknown[]) : [];
      const roles = rawRoles
        .filter((entry): entry is string => typeof entry === 'string')
        .map(parseGrant)
        .filter((grant): grant is RoleGrant => grant !== null);

      req.auth = { userId: sub, roles, jti };
    } catch (error) {
      // An invalid token is not an error response here: the route decides whether
      // it needed one. Unauthenticated and "bad token" must look the same.
      req.log.debug({ err: error }, 'access token rejected');
    }
  });

  done();
}, { name: 'auth', fastify: '5.x' });

export function requireAuth(req: FastifyRequest): AuthContext {
  if (req.auth === null) throw unauthorized('A valid access token is required');
  return req.auth;
}
