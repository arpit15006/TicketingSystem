import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { formatGrant, type RoleGrant } from '@ticketing/contracts';
import type { Config } from './config.js';
import type { SigningKeys } from './keys.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  familyId: string;
  jti: string;
}

/**
 * The refresh token is opaque and stored only as a SHA-256 digest.
 *
 * Unlike a password, this is a 256-bit random value with no structure to guess, so
 * a fast digest is appropriate — argon2's slowness buys nothing against an input
 * that cannot be brute-forced. What matters is that a database dump yields no
 * usable tokens.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateRefreshToken(): string {
  // PRD §9.1 — opaque, 32 bytes.
  return randomBytes(32).toString('base64url');
}

export async function signAccessToken(
  keys: SigningKeys,
  config: Config,
  args: { userId: string; roles: RoleGrant[]; jti: string },
): Promise<string> {
  // PRD §9.1 — claims: sub, roles[], jti, exp, iat.
  return new SignJWT({ roles: args.roles.map(formatGrant) })
    .setProtectedHeader({ alg: 'RS256', kid: keys.keyId })
    .setSubject(args.userId)
    .setJti(args.jti)
    .setIssuedAt()
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(keys.privateKey);
}

export async function loadRoles(db: Pool | PoolClient, userId: string): Promise<RoleGrant[]> {
  const result = await db.query<{ role: string; resource_type: string | null; resource_id: string | null }>(
    `SELECT role, resource_type, resource_id FROM role_assignments WHERE user_id = $1 ORDER BY role`,
    [userId],
  );
  return result.rows.map((row) => ({
    role: row.role as RoleGrant['role'],
    resourceType: row.resource_type as RoleGrant['resourceType'],
    resourceId: row.resource_id,
  }));
}

/** Issue a fresh pair, starting a new rotation family (login) or continuing one (refresh). */
export async function issueTokenPair(
  db: PoolClient,
  keys: SigningKeys,
  config: Config,
  args: { userId: string; familyId?: string },
): Promise<TokenPair> {
  const familyId = args.familyId ?? randomUUID();
  const jti = randomUUID();
  const roles = await loadRoles(db, args.userId);

  const refreshToken = generateRefreshToken();
  await db.query(
    `INSERT INTO refresh_tokens (user_id, family_id, hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
    [args.userId, familyId, hashRefreshToken(refreshToken), String(config.refreshTokenTtlSeconds)],
  );

  const accessToken = await signAccessToken(keys, config, { userId: args.userId, roles, jti });
  return { accessToken, refreshToken, expiresIn: config.accessTokenTtlSeconds, familyId, jti };
}

/** Kill an entire rotation chain. Used on logout and on reuse detection. */
export async function revokeFamily(db: PoolClient, familyId: string): Promise<number> {
  const result = await db.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  );
  return result.rowCount ?? 0;
}

export type RefreshOutcome =
  | { kind: 'rotated'; tokens: TokenPair }
  | { kind: 'unknown' }
  | { kind: 'expired' }
  | { kind: 'reused'; familyId: string; userId: string; revokedCount: number };

/**
 * ADR-011 — rotation with reuse detection.
 *
 * Every refresh consumes the presented token and issues a new one in the same
 * family. So a token that is presented *after* it was already rotated can only mean
 * one of two things: a client retried with a stale token, or an attacker is using a
 * copy that was stolen before the legitimate client rotated it.
 *
 * Those are indistinguishable from here, and only one of them is dangerous, so the
 * safe reading wins: the whole family is revoked and both parties must log in
 * again. A stolen refresh token is therefore usable at most once before the theft
 * becomes visible — which is the entire point of rotation.
 *
 * The row is locked FOR UPDATE so two simultaneous refreshes cannot both rotate the
 * same token and race into issuing two live families.
 */
export async function rotateRefreshToken(
  db: PoolClient,
  keys: SigningKeys,
  config: Config,
  presentedToken: string,
): Promise<RefreshOutcome> {
  const existing = await db.query<{
    token_id: string;
    user_id: string;
    family_id: string;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT token_id, user_id, family_id, expires_at, revoked_at
     FROM refresh_tokens WHERE hash = $1 FOR UPDATE`,
    [hashRefreshToken(presentedToken)],
  );

  const row = existing.rows[0];
  if (row === undefined) return { kind: 'unknown' };

  if (row.revoked_at !== null) {
    const revokedCount = await revokeFamily(db, row.family_id);
    return { kind: 'reused', familyId: row.family_id, userId: row.user_id, revokedCount };
  }

  if (row.expires_at.getTime() <= Date.now()) return { kind: 'expired' };

  await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_id = $1`, [row.token_id]);

  const tokens = await issueTokenPair(db, keys, config, { userId: row.user_id, familyId: row.family_id });
  return { kind: 'rotated', tokens };
}
