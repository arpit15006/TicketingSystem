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
  kafkaBrokers: string[];
  consumerGroupId: string;
  jwksUri: string;
  jwtIssuer: string;
  jwtAudience: string;
  logLevel: string;
  nodeEnv: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const databaseUrl = overrides.databaseUrl ?? process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is required');

  return {
    port: int('PORT', 3006),
    host: process.env['HOST'] ?? '0.0.0.0',
    databaseUrl,
    pgPoolMax: int('PG_POOL_MAX', 10),
    kafkaBrokers: (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',').map((broker) => broker.trim()),
    consumerGroupId: process.env['CONSUMER_GROUP_ID'] ?? 'notification',
    jwksUri: process.env['JWKS_URI'] ?? 'http://localhost:3001/.well-known/jwks.json',
    jwtIssuer: process.env['JWT_ISSUER'] ?? 'http://localhost:3001',
    jwtAudience: process.env['JWT_AUDIENCE'] ?? 'ticketing',
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    ...overrides,
  };
}
