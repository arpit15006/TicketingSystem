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
  /** PRD §8.1 — default hold duration is 480 seconds (8 minutes). */
  holdDurationSeconds: number;
  maxSeatsPerHold: number;
  pgPoolMax: number;
  statementTimeoutMs: number;
  janitorEnabled: boolean;
  janitorIntervalMs: number;
  /** ADR-010 — this service verifies access tokens itself; it never trusts a header. */
  jwksUri: string;
  jwtIssuer: string;
  jwtAudience: string;
  /** Shared secret proving a caller is another service, not an end user. */
  internalServiceToken: string;
  kafkaBrokers: string[];
  /** ADR-005 — the relay is a background worker; nothing on the correctness path. */
  outboxRelayEnabled: boolean;
  outboxRelayIntervalMs: number;
  logLevel: string;
  nodeEnv: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const databaseUrl = overrides.databaseUrl ?? process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required');
  }

  return {
    port: int('PORT', 3003),
    host: process.env['HOST'] ?? '0.0.0.0',
    databaseUrl,
    holdDurationSeconds: int('HOLD_DURATION_SECONDS', 480),
    maxSeatsPerHold: int('MAX_SEATS_PER_HOLD', 10),
    pgPoolMax: int('PG_POOL_MAX', 20),
    statementTimeoutMs: int('PG_STATEMENT_TIMEOUT_MS', 10_000),
    // ADR-003: the janitor is cosmetic. It is safe for it to never run, which is
    // why it defaults to off in tests and why no test depends on it.
    janitorEnabled: (process.env['JANITOR_ENABLED'] ?? 'true') === 'true',
    janitorIntervalMs: int('JANITOR_INTERVAL_MS', 60_000),
    jwksUri: process.env['JWKS_URI'] ?? 'http://localhost:3001/.well-known/jwks.json',
    jwtIssuer: process.env['JWT_ISSUER'] ?? 'http://localhost:3001',
    jwtAudience: process.env['JWT_AUDIENCE'] ?? 'ticketing',
    internalServiceToken: process.env['INTERNAL_SERVICE_TOKEN'] ?? 'dev-internal-service-token-change-me',
    kafkaBrokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',').map((broker) => broker.trim()),
    outboxRelayEnabled: (process.env['OUTBOX_RELAY_ENABLED'] ?? 'true') === 'true',
    outboxRelayIntervalMs: int('OUTBOX_RELAY_INTERVAL_MS', 500),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    ...overrides,
  };
}
