import type { PoolClient } from 'pg';
import type { EventTypeName } from '@ticketing/contracts';

/**
 * ADR-005 — the transactional outbox.
 *
 * This takes a PoolClient, never a Pool, and that is the entire point: the event row
 * must be written by the *same* transaction as the state change it describes. If it
 * could be handed a Pool it could be called outside the transaction, which would
 * reintroduce the DB+Kafka dual write the outbox exists to eliminate.
 *
 * Phase 4 adds the relay that publishes these rows. Until then they simply accumulate
 * with published_at IS NULL, which is exactly what the relay will expect to find.
 */
export async function writeOutbox(
  client: PoolClient,
  args: { aggregateId: string; eventType: EventTypeName; payload: unknown; requestId: string | null },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (aggregate_id, event_type, payload, request_id) VALUES ($1, $2, $3, $4)`,
    [args.aggregateId, args.eventType, JSON.stringify(args.payload), args.requestId],
  );
}
