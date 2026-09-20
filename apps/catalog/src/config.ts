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
  jwksUri: string;
  jwtIssuer: string;
  jwtAudience: string;
  /** Empty disables seatmap caching entirely; reads then always hit Postgres. */
  redisUrl: string;
  seatmapCacheTtlSeconds: number;
  identityUrl: string;
  internalServiceToken: string;
  logLevel: string;
  nodeEnv: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const databaseUrl = overrides.databaseUrl ?? process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required');

  return {
    port: int('PORT', 3002),
    host: process.env['HOST'] ?? '0.0.0.0',
    databaseUrl,
    pgPoolMax: int('PG_POOL_MAX', 20),
    jwksUri: process.env['JWKS_URI'] ?? 'http://localhost:3001/.well-known/jwks.json',
    jwtIssuer: process.env['JWT_ISSUER'] ?? 'http://localhost:3001',
    jwtAudience: process.env['JWT_AUDIENCE'] ?? 'ticketing',
    redisUrl: process.env['REDIS_URL'] ?? '',
    // ADR-006 — a seatmap may be seconds stale; an allocation may not be stale at all.
    seatmapCacheTtlSeconds: int('SEATMAP_CACHE_TTL_SECONDS', 5),
    identityUrl: process.env['IDENTITY_URL'] ?? 'http://localhost:3001',
    internalServiceToken: process.env['INTERNAL_SERVICE_TOKEN'] ?? 'dev-internal-service-token-change-me',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    ...overrides,
  };
}
