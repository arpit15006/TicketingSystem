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
  internalServiceToken: string;
  reservationUrl: string;
  catalogUrl: string;
  razorpayBaseUrl: string;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  razorpayWebhookSecret: string;
  currency: string;
  /**
   * PRD §10.1.3 — refuse to start a payment when less than this much hold remains.
   * This is the mechanism that bounds the payment-after-expiry race (ADR-008).
   */
  minHoldSecondsForOrder: number;
  /** PRD §10.1.4 — extend the hold when the payment intent is created. */
  holdExtensionSeconds: number;
  kafkaBrokers: string[];
  /** ADR-005 — the relay is a background worker; nothing on the correctness path. */
  outboxRelayEnabled: boolean;
  outboxRelayIntervalMs: number;
  logLevel: string;
  nodeEnv: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const databaseUrl = overrides.databaseUrl ?? process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required');

  const config: Config = {
    port: int('PORT', 3004),
    host: process.env['HOST'] ?? '0.0.0.0',
    databaseUrl,
    pgPoolMax: int('PG_POOL_MAX', 20),
    jwksUri: process.env['JWKS_URI'] ?? 'http://localhost:3001/.well-known/jwks.json',
    jwtIssuer: process.env['JWT_ISSUER'] ?? 'http://localhost:3001',
    jwtAudience: process.env['JWT_AUDIENCE'] ?? 'ticketing',
    internalServiceToken: process.env['INTERNAL_SERVICE_TOKEN'] ?? 'dev-internal-service-token-change-me',
    reservationUrl: process.env['RESERVATION_URL'] ?? 'http://localhost:3003',
    catalogUrl: process.env['CATALOG_URL'] ?? 'http://localhost:3002',
    razorpayBaseUrl: process.env['RAZORPAY_BASE_URL'] ?? 'https://api.razorpay.com',
    razorpayKeyId: process.env['RAZORPAY_KEY_ID'] ?? '',
    razorpayKeySecret: process.env['RAZORPAY_KEY_SECRET'] ?? '',
    razorpayWebhookSecret: process.env['RAZORPAY_WEBHOOK_SECRET'] ?? '',
    currency: process.env['CURRENCY'] ?? 'INR',
    minHoldSecondsForOrder: int('MIN_HOLD_SECONDS_FOR_ORDER', 90),
    holdExtensionSeconds: int('HOLD_EXTENSION_SECONDS', 600),
    kafkaBrokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',').map((broker) => broker.trim()),
    outboxRelayEnabled: (process.env['OUTBOX_RELAY_ENABLED'] ?? 'true') === 'true',
    outboxRelayIntervalMs: int('OUTBOX_RELAY_INTERVAL_MS', 500),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    ...overrides,
  };

  if (config.nodeEnv === 'production') {
    // Starting without these would mean accepting unverifiable payment claims.
    for (const key of ['razorpayKeyId', 'razorpayKeySecret', 'razorpayWebhookSecret'] as const) {
      if (config[key] === '') throw new Error(`${key} is required in production`);
    }
  }

  return config;
}
