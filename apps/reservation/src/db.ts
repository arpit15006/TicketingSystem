/**
 * The generic pool/transaction helpers now live in @ticketing/http so that every
 * service shares one implementation. Re-exported here so the allocation code keeps
 * reading against a local, service-shaped module.
 */
export { createPool, withTransaction, withDeadlockRetry, pgErrorCode, PgError } from '@ticketing/http';
export type { Pool, PoolClient } from 'pg';
