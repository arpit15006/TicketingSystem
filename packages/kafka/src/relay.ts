import type { Pool } from 'pg';
import { withTransaction } from '@ticketing/http';
import { buildEnvelope, type OutboxRow } from './envelope.js';
import type { EventPublisher } from './producer.js';

export interface RelayLogger {
  debug: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface OutboxRelayOptions {
  pool: Pool;
  publisher: EventPublisher;
  /** Namespaces the derived event_id, so two services' row 42 never collide. */
  serviceName: string;
  batchSize?: number;
  intervalMs?: number;
  logger: RelayLogger;
}

export interface RelayCycleResult {
  published: number;
  failed: boolean;
  error?: string;
}

export interface OutboxRelay {
  /** One pass. Exposed so tests can drive the relay deterministically. */
  runOnce: () => Promise<RelayCycleResult>;
  start: () => void;
  stop: () => Promise<void>;
}

/**
 * ============================================================================
 *  THE OUTBOX RELAY — PRD §11.1, ADR-005
 * ============================================================================
 *
 *  Writing to Postgres and then publishing to Kafka is a dual write across two
 *  systems with no shared transaction. If the process dies between them, the seat
 *  is sold and no notification ever fires — a silent, permanent inconsistency
 *  that no retry can detect, because nothing recorded that the event was owed.
 *
 *  The outbox collapses both writes into one atomic operation against a single
 *  system. This relay then makes publishing a retryable, resumable problem.
 *
 *  The ordering below is what makes the outage case safe:
 *
 *      BEGIN
 *        SELECT ... WHERE published_at IS NULL ... FOR UPDATE SKIP LOCKED
 *        publish to Kafka            ← if this throws, we never reach the UPDATE
 *        UPDATE ... SET published_at = now()
 *      COMMIT
 *
 *  A failed publish rolls the whole cycle back, so the rows stay unpublished and
 *  the next cycle retries them. Nothing is ever marked published that was not
 *  actually sent.
 *
 *  The converse is possible and accepted: a publish can succeed and the COMMIT
 *  then fail, so the row is sent twice. That is why delivery is at-least-once and
 *  why EVERY consumer must dedupe on event_id (which is stable across retries).
 *
 *  SKIP LOCKED lets several relay instances run concurrently without handing the
 *  same row to two of them.
 */
export function createOutboxRelay(options: OutboxRelayOptions): OutboxRelay {
  const batchSize = options.batchSize ?? 100;
  const intervalMs = options.intervalMs ?? 500;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const runOnce = async (): Promise<RelayCycleResult> => {
    try {
      return await withTransaction(options.pool, async (client) => {
        const rows = await client.query<OutboxRow>(
          `SELECT id, aggregate_id, event_type, payload, request_id, created_at
           FROM outbox
           WHERE published_at IS NULL
           ORDER BY id
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [batchSize],
        );

        if (rows.rowCount === 0) return { published: 0, failed: false };

        const messages = rows.rows.map((row) => buildEnvelope(row, options.serviceName));

        // If this throws, the UPDATE below never runs and the transaction rolls
        // back. The rows remain unpublished, which is exactly what we want.
        await options.publisher.publish(messages);

        await client.query(`UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])`, [
          rows.rows.map((row) => row.id),
        ]);

        options.logger.debug({ published: rows.rowCount }, 'outbox relay published a batch');
        return { published: rows.rowCount ?? 0, failed: false };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Not an error worth waking anyone for: the events are still safe in the
      // outbox and the next cycle will retry them.
      options.logger.warn({ err: message }, 'outbox relay cycle failed; events remain unpublished and will retry');
      return { published: 0, failed: true, error: message };
    }
  };

  const tick = (): void => {
    if (running) return; // never let cycles overlap
    running = true;
    void runOnce().finally(() => {
      running = false;
    });
  };

  return {
    runOnce,
    start: () => {
      if (timer !== null) return;
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    stop: async () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await options.publisher.disconnect();
    },
  };
}
