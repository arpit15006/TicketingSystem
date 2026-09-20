import { EVENT_TYPE_TO_TOPIC, type EventEnvelope, type EventTypeName, type TopicName } from '@ticketing/contracts';

export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  request_id: string | null;
  created_at: Date;
}

export interface OutboundMessage {
  topic: TopicName;
  key: string;
  envelope: EventEnvelope;
}

/**
 * PRD §11 — the event envelope: `event_id`, `occurred_at`, `request_id`.
 *
 * `event_id` is derived from the producing service plus the outbox row id rather
 * than generated fresh. That makes it STABLE across retries: if the relay publishes
 * a row and then fails before marking it published, the redelivery carries the same
 * id, and a consumer deduping on `event_id` recognises it. A random id per publish
 * attempt would make at-least-once delivery indistinguishable from two real events,
 * which is the whole thing consumers are trying to tell apart (ADR-005).
 */
export function buildEnvelope(row: OutboxRow, serviceName: string): OutboundMessage {
  const eventType = row.event_type as EventTypeName;
  const topic = EVENT_TYPE_TO_TOPIC[eventType];
  if (topic === undefined) throw new Error(`No topic mapped for event type "${row.event_type}"`);

  return {
    topic,
    // PRD §11 — partition by the aggregate so events for one entity stay ordered.
    key: row.aggregate_id,
    envelope: {
      event_id: `${serviceName}-${row.id}`,
      event_type: eventType,
      aggregate_id: row.aggregate_id,
      occurred_at: row.created_at.toISOString(),
      request_id: row.request_id,
      payload: row.payload,
    },
  };
}
