function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  return parsed;
}

/** Comma-separated list → trimmed, non-empty entries. */
function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

export interface Config {
  port: number;
  host: string;
  identityUrl: string;
  catalogUrl: string;
  reservationUrl: string;
  ordersUrl: string;
  waitingRoomUrl: string;
  notificationUrl: string;
  jwksUri: string;
  jwtIssuer: string;
  jwtAudience: string;
  redisUrl: string;
  admissionTokenSecret: string;
  /**
   * Browser origins allowed to call the edge.
   *
   * An allowlist rather than `*`: the gateway is the only component a browser
   * ever talks to, so this is the whole CORS surface of the platform. `*` would
   * also forbid credentialed requests outright, and it invites a future reader to
   * assume the edge is public when it is not.
   */
  corsOrigins: string[];
  rateLimitMax: number;
  /**
   * Shared secret that exempts a caller from the rate limit, for a load
   * generator that must be allowed to look like a thundering herd.
   *
   * EMPTY DISABLES IT ENTIRELY, which is the default and the production setting:
   * with no token configured there is no bypass to present. It is a secret and
   * not an IP allowlist on purpose — behind a bridge or a proxy the generator
   * shares an address with ordinary browsers, so exempting the address would
   * exempt them too.
   */
  rateLimitBypassToken: string;
  rateLimitWindowMs: number;
  logLevel: string;
  nodeEnv: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: int('PORT', 3000),
    host: process.env['HOST'] ?? '0.0.0.0',
    identityUrl: process.env['IDENTITY_URL'] ?? 'http://localhost:3001',
    catalogUrl: process.env['CATALOG_URL'] ?? 'http://localhost:3002',
    reservationUrl: process.env['RESERVATION_URL'] ?? 'http://localhost:3003',
    ordersUrl: process.env['ORDERS_URL'] ?? 'http://localhost:3004',
    waitingRoomUrl: process.env['WAITING_ROOM_URL'] ?? 'http://localhost:3005',
    notificationUrl: process.env['NOTIFICATION_URL'] ?? 'http://localhost:3006',
    jwksUri: process.env['JWKS_URI'] ?? 'http://localhost:3001/.well-known/jwks.json',
    jwtIssuer: process.env['JWT_ISSUER'] ?? 'http://localhost:3001',
    jwtAudience: process.env['JWT_AUDIENCE'] ?? 'ticketing',
    redisUrl: process.env['REDIS_URL'] ?? '',
    admissionTokenSecret: process.env['ADMISSION_TOKEN_SECRET'] ?? 'dev-admission-secret-change-me',
    // apps/web runs on 3007: the gateway owns 3000 and notification owns 3006.
    corsOrigins: list('CORS_ORIGINS', ['http://localhost:3007']),
    rateLimitMax: int('RATE_LIMIT_MAX', 300),
    rateLimitBypassToken: process.env['RATE_LIMIT_BYPASS_TOKEN'] ?? '',
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    ...overrides,
  };
}
