import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Pool } from 'pg';
import { createLogger, LogEvent } from '@ticketing/logger';
import {
  requestIdPlugin,
  errorHandlerPlugin,
  authPlugin,
  requirePermission,
  requireAuth,
  requireServiceToken,
  withTransaction,
  AppError,
  PgError,
  pgErrorCode,
} from '@ticketing/http';
import { ErrorCode, ROLES, type RoleGrant } from '@ticketing/contracts';
import type { Config } from './config.js';
import type { SigningKeys } from './keys.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { issueTokenPair, rotateRefreshToken, revokeFamily, loadRoles, hashRefreshToken } from './tokens.js';
import type { TokenDenylist } from './denylist.js';

export type IdentityServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger,
  TypeBoxTypeProvider
>;

const Email = Type.String({ format: 'email', maxLength: 320 });
// Length beats composition rules: a 12-character passphrase resists guessing far
// better than "must contain a symbol" ever did, and does not push users to Pa55w0rd!.
const Password = Type.String({ minLength: 12, maxLength: 200 });

export interface BuildServerOptions {
  config: Config;
  pool: Pool;
  keys: SigningKeys;
  denylist: TokenDenylist;
}

export async function buildServer({ config, pool, keys, denylist }: BuildServerOptions): Promise<IdentityServer> {
  const app = Fastify({
    loggerInstance: createLogger({ service: 'identity', level: config.logLevel, pretty: config.nodeEnv === 'development' }),
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return (Array.isArray(header) ? header[0] : header) ?? '';
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(requestIdPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin, {
    // Identity verifies its own tokens too — /me and the role routes need an
    // authenticated caller, and it must not special-case itself. It verifies
    // against the key it already holds rather than calling its own endpoint.
    localJwks: keys.jwks,
    issuer: config.issuer,
    audience: config.audience,
    isRevoked: denylist.isRevoked,
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'identity' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });

  /**
   * PRD §9.1 — the public key, so every service can verify tokens independently.
   * Cached hard: verifiers poll this and it changes only on key rotation.
   */
  app.get('/.well-known/jwks.json', async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=600').send(keys.jwks),
  );

  /* ------------------------------------------------------------- register */

  app.post(
    '/auth/register',
    {
      schema: {
        body: Type.Object(
          { email: Email, password: Password, fullName: Type.String({ minLength: 1, maxLength: 200 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const { email, password, fullName } = req.body;
      const passwordHash = await hashPassword(password);

      const result = await withTransaction(pool, async (client) => {
        let userId: string;
        try {
          const inserted = await client.query<{ user_id: string }>(
            `INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING user_id`,
            [email, passwordHash, fullName],
          );
          const row = inserted.rows[0];
          if (row === undefined) throw new Error('user insert returned no row');
          userId = row.user_id;
        } catch (error) {
          if (pgErrorCode(error) === PgError.uniqueViolation) {
            throw new AppError(409, ErrorCode.emailAlreadyRegistered, 'That email is already registered');
          }
          throw error;
        }

        // Everyone starts as an attendee. The role is global because "may attempt a
        // booking" is not scoped to anything; what the booking may touch is decided
        // by the service that owns the seat.
        await client.query(`INSERT INTO role_assignments (user_id, role) VALUES ($1, 'attendee')`, [userId]);

        // Bootstrap: the configured address becomes a platform administrator on
        // first registration. Logged at warn so it can never happen unnoticed.
        if (
          config.bootstrapAdminEmail !== undefined &&
          config.bootstrapAdminEmail.toLowerCase() === email.toLowerCase()
        ) {
          await client.query(`INSERT INTO role_assignments (user_id, role) VALUES ($1, 'platform_admin')`, [userId]);
          req.log.warn({ userId, email }, 'bootstrap platform_admin granted');
        }

        const tokens = await issueTokenPair(client, keys, config, { userId });
        return { userId, tokens };
      });

      req.log.info({ userId: result.userId }, 'user registered');
      return reply.status(201).send({
        userId: result.userId,
        email,
        fullName,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresIn: result.tokens.expiresIn,
      });
    },
  );

  /* ---------------------------------------------------------------- login */

  app.post(
    '/auth/login',
    { schema: { body: Type.Object({ email: Email, password: Type.String({ minLength: 1 }) }, { additionalProperties: false }) } },
    async (req, reply) => {
      const { email, password } = req.body;

      const found = await pool.query<{ user_id: string; password_hash: string }>(
        `SELECT user_id, password_hash FROM users WHERE email = $1`,
        [email],
      );
      const user = found.rows[0];

      // Same error for "no such user" and "wrong password": distinguishing them
      // turns the login form into an account-enumeration oracle.
      const ok = user !== undefined && (await verifyPassword(password, user.password_hash));
      if (!ok || user === undefined) {
        req.log.info({ email }, 'login rejected');
        throw new AppError(401, ErrorCode.invalidCredentials, 'Invalid email or password');
      }

      const tokens = await withTransaction(pool, async (client) =>
        issueTokenPair(client, keys, config, { userId: user.user_id }),
      );

      return reply.status(200).send({
        userId: user.user_id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      });
    },
  );

  /* -------------------------------------------------------------- refresh */

  app.post(
    '/auth/refresh',
    { schema: { body: Type.Object({ refreshToken: Type.String({ minLength: 1 }) }, { additionalProperties: false }) } },
    async (req, reply) => {
      const outcome = await withTransaction(pool, async (client) =>
        rotateRefreshToken(client, keys, config, req.body.refreshToken),
      );

      if (outcome.kind === 'reused') {
        // ADR-011 — a token presented after rotation means the chain is compromised.
        req.log.warn(
          { event: LogEvent.refreshReuseDetected, familyId: outcome.familyId, userId: outcome.userId, revokedCount: outcome.revokedCount },
          'refresh token reuse detected: entire family revoked',
        );
        throw new AppError(401, ErrorCode.refreshTokenReused, 'Refresh token reuse detected; all sessions revoked');
      }

      if (outcome.kind !== 'rotated') {
        throw new AppError(401, ErrorCode.invalidRefreshToken, 'Refresh token is invalid or expired');
      }

      return reply.status(200).send({
        accessToken: outcome.tokens.accessToken,
        refreshToken: outcome.tokens.refreshToken,
        expiresIn: outcome.tokens.expiresIn,
      });
    },
  );

  /* --------------------------------------------------------------- logout */

  app.post(
    '/auth/logout',
    { schema: { body: Type.Object({ refreshToken: Type.String({ minLength: 1 }) }, { additionalProperties: false }) } },
    async (req, reply) => {
      const auth = req.auth;

      await withTransaction(pool, async (client) => {
        const found = await client.query<{ family_id: string }>(
          `SELECT family_id FROM refresh_tokens WHERE hash = $1`,
          [hashRefreshToken(req.body.refreshToken)],
        );
        const family = found.rows[0];
        if (family !== undefined) await revokeFamily(client, family.family_id);
      });

      // The access token stays cryptographically valid until it expires, so the
      // denylist covers the remaining window (ADR-011). Without it, "log out" would
      // be a lie for up to 10 minutes.
      if (auth !== null) {
        await denylist.revoke(auth.jti, Math.floor(Date.now() / 1000) + config.accessTokenTtlSeconds);
      }

      return reply.status(204).send();
    },
  );

  /* ------------------------------------------------------------------ me */

  app.get('/me', async (req) => {
    const auth = requireAuth(req);
    const user = await pool.query<{ user_id: string; email: string; full_name: string }>(
      `SELECT user_id, email, full_name FROM users WHERE user_id = $1`,
      [auth.userId],
    );
    const row = user.rows[0];
    if (row === undefined) throw new AppError(404, ErrorCode.notFound, 'User not found');

    return { userId: row.user_id, email: row.email, fullName: row.full_name, roles: await loadRoles(pool, auth.userId) };
  });

  /* ------------------------------------------------------ role management */

  app.post(
    '/users/:userId/roles',
    {
      schema: {
        params: Type.Object({ userId: Type.String({ format: 'uuid' }) }),
        body: Type.Object(
          {
            role: Type.Union(ROLES.map((role) => Type.Literal(role))),
            resourceType: Type.Optional(Type.Union([Type.Literal('event'), Type.Literal('venue')])),
            resourceId: Type.Optional(Type.String({ format: 'uuid' })),
          },
          { additionalProperties: false },
        ),
      },
      // Granting roles is the keys to the kingdom; only a global platform_admin may.
      preHandler: requirePermission('event:create'),
    },
    async (req, reply) => {
      const auth = requireAuth(req);
      const isPlatformAdmin = auth.roles.some((g: RoleGrant) => g.role === 'platform_admin' && g.resourceType === null);
      if (!isPlatformAdmin) throw new AppError(403, ErrorCode.forbidden, 'Only a platform administrator may grant roles');

      const { role, resourceType, resourceId } = req.body;
      if ((resourceType === undefined) !== (resourceId === undefined)) {
        throw new AppError(422, ErrorCode.validationFailed, 'resourceType and resourceId must be given together');
      }

      await pool.query(
        `INSERT INTO role_assignments (user_id, role, resource_type, resource_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [req.params.userId, role, resourceType ?? null, resourceId ?? null],
      );

      req.log.info({ grantedTo: req.params.userId, role, resourceType, resourceId }, 'role granted');
      return reply.status(201).send({ userId: req.params.userId, roles: await loadRoles(pool, req.params.userId) });
    },
  );

  /* --------------------------------------------- internal role grants */

  /**
   * How a resource-scoped grant comes into existence without a human admin.
   *
   * PRD §9.2 scopes `organizer` to "events they own" and `venue_admin` to "venues
   * they administer". Ownership is a fact catalog holds, but grants live here, and
   * reservation — which cannot see catalog's tables (ADR-004) — authorizes seat
   * provisioning by an explicit `organizer:event:<id>` grant. Without this route
   * the only way to get one is a platform admin typing it in, and an organizer who
   * has just created an event cannot provision its seats.
   *
   * So catalog, the service that *knows* who created the event, tells identity,
   * the service that *stores* grants — over service auth, not by sharing a table.
   * The route accepts only the two scoped roles this handoff needs; a service
   * token must never be able to mint `platform_admin`.
   */
  app.post(
    '/internal/users/:userId/roles',
    {
      schema: {
        params: Type.Object({ userId: Type.String({ format: 'uuid' }) }),
        body: Type.Object(
          {
            role: Type.Union([Type.Literal('organizer'), Type.Literal('venue_admin'), Type.Literal('scanner')]),
            resourceType: Type.Union([Type.Literal('event'), Type.Literal('venue')]),
            resourceId: Type.String({ format: 'uuid' }),
          },
          { additionalProperties: false },
        ),
      },
      preHandler: requireServiceToken(config.internalServiceToken),
    },
    async (req, reply) => {
      const { role, resourceType, resourceId } = req.body;
      await pool.query(
        `INSERT INTO role_assignments (user_id, role, resource_type, resource_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [req.params.userId, role, resourceType, resourceId],
      );
      req.log.info({ grantedTo: req.params.userId, role, resourceType, resourceId, via: 'service' }, 'role granted');
      return reply.status(201).send({ userId: req.params.userId, roles: await loadRoles(pool, req.params.userId) });
    },
  );

  return app;
}
