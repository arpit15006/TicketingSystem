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
  redisUrl: string;
  jwksUri: string;
  jwtIssuer: string;
  jwtAudience: string;
  /**
   * Secret for admission tokens (HS256).
   *
   * Symmetric is deliberate here. An admission token grants a place in a queue and
   * nothing else — it confers no authority over a seat, an order or money, all of
   * which are decided by services that re-verify the user's own RS256 token. The
   * worst a forged admission token achieves is skipping a queue. Asymmetric keys
   * buy multi-verifier and revocation properties that nothing in this flow needs.
   */
  admissionTokenSecret: string;
  admissionTtlSeconds: number;
  /** PRD §12 — admit N users per second. Default 50. */
  admissionRatePerSecond: number;
  admitterIntervalMs: number;
  /** PRD §12 — SSE pushes position every 2 seconds. */
  ssePositionIntervalMs: number;
  logLevel: string;
  nodeEnv: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: int('PORT', 3005),
    host: process.env['HOST'] ?? '0.0.0.0',
    redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    jwksUri: process.env['JWKS_URI'] ?? 'http://localhost:3001/.well-known/jwks.json',
    jwtIssuer: process.env['JWT_ISSUER'] ?? 'http://localhost:3001',
    jwtAudience: process.env['JWT_AUDIENCE'] ?? 'ticketing',
    admissionTokenSecret: process.env['ADMISSION_TOKEN_SECRET'] ?? 'dev-admission-secret-change-me',
    admissionTtlSeconds: int('ADMISSION_TTL_SECONDS', 600),
    admissionRatePerSecond: int('ADMISSION_RATE_PER_SECOND', 50),
    admitterIntervalMs: int('ADMITTER_INTERVAL_MS', 1_000),
    ssePositionIntervalMs: int('SSE_POSITION_INTERVAL_MS', 2_000),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    ...overrides,
  };
}
