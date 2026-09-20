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
  identityUrl: string;
  catalogUrl: string;
  reservationUrl: string;
  ordersUrl: string;
  waitingRoomUrl: string;
  jwksUri: string;
  jwtIssuer: string;
  jwtAudience: string;
  redisUrl: string;
  admissionTokenSecret: string;
  rateLimitMax: number;
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
    jwksUri: process.env['JWKS_URI'] ?? 'http://localhost:3001/.well-known/jwks.json',
    jwtIssuer: process.env['JWT_ISSUER'] ?? 'http://localhost:3001',
    jwtAudience: process.env['JWT_AUDIENCE'] ?? 'ticketing',
    redisUrl: process.env['REDIS_URL'] ?? '',
    admissionTokenSecret: process.env['ADMISSION_TOKEN_SECRET'] ?? 'dev-admission-secret-change-me',
    rateLimitMax: int('RATE_LIMIT_MAX', 300),
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    ...overrides,
  };
}
