function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return parsed;
}

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  pgPoolMax: number;
  /** PRD §9.1 — access tokens live 10 minutes. */
  accessTokenTtlSeconds: number;
  /** PRD §9.1 — refresh tokens live 14 days and rotate on every use. */
  refreshTokenTtlSeconds: number;
  issuer: string;
  audience: string;
  /** PEM keypair. Generated at boot when absent, which is fine for dev and tests only. */
  privateKeyPem: string | undefined;
  publicKeyPem: string | undefined;
  keyId: string | undefined;
  /**
   * The first administrator has to come from somewhere. Registering with this
   * address also grants platform_admin, which avoids the alternative — a seed
   * script reaching into identity's database to write a grant, exactly the
   * cross-service database access ADR-004 forbids.
   */
  bootstrapAdminEmail: string | undefined;
  /** Empty disables the shared denylist and falls back to the in-process one. */
  redisUrl: string;
  logLevel: string;
  nodeEnv: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const databaseUrl = overrides.databaseUrl ?? process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required');

  return {
    port: int('PORT', 3001),
    host: process.env['HOST'] ?? '0.0.0.0',
    databaseUrl,
    pgPoolMax: int('PG_POOL_MAX', 20),
    accessTokenTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 600),
    refreshTokenTtlSeconds: int('REFRESH_TOKEN_TTL_SECONDS', 14 * 24 * 60 * 60),
    issuer: process.env['JWT_ISSUER'] ?? 'http://localhost:3001',
    audience: process.env['JWT_AUDIENCE'] ?? 'ticketing',
    privateKeyPem: process.env['JWT_PRIVATE_KEY'],
    publicKeyPem: process.env['JWT_PUBLIC_KEY'],
    keyId: process.env['JWT_KEY_ID'],
    bootstrapAdminEmail: process.env['BOOTSTRAP_ADMIN_EMAIL'],
    redisUrl: process.env['REDIS_URL'] ?? '',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    ...overrides,
  };
}
