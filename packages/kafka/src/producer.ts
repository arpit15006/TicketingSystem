import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { OutboundMessage } from './envelope.js';

export interface EventPublisher {
  connect: () => Promise<void>;
  publish: (messages: readonly OutboundMessage[]) => Promise<void>;
  disconnect: () => Promise<void>;
}

export interface ProducerOptions {
  brokers: string[];
  clientId: string;
  /** Keep retries short: the outbox is the durability layer, not the producer. */
  retries?: number;
}

export function createKafkaProducer(options: ProducerOptions): EventPublisher {
  const kafka = new Kafka({
    clientId: options.clientId,
    brokers: options.brokers,
    logLevel: logLevel.NOTHING,
    connectionTimeout: 3_000,
    requestTimeout: 10_000,
    /*
     * Deliberately few retries.
     *
     * When the broker is down, the right behaviour is to fail fast and leave the
     * outbox row unpublished so the next relay cycle tries again. A producer
     * retrying for minutes would hold a database transaction open across the whole
     * outage — turning a broker problem into a database problem.
     */
    retry: { retries: options.retries ?? 2, initialRetryTime: 100, maxRetryTime: 1_000 },
  });

  let producer: Producer | null = null;

  return {
    connect: async () => {
      producer ??= kafka.producer({ allowAutoTopicCreation: true, idempotent: false });
      await producer.connect();
    },

    publish: async (messages) => {
      if (messages.length === 0) return;
      if (producer === null) {
        producer = kafka.producer({ allowAutoTopicCreation: true, idempotent: false });
        await producer.connect();
      }

      // Group by topic so one call publishes a whole batch per topic.
      const byTopic = new Map<string, { key: string; value: string; headers: Record<string, string> }[]>();
      for (const message of messages) {
        const list = byTopic.get(message.topic) ?? [];
        list.push({
          key: message.key,
          value: JSON.stringify(message.envelope),
          headers: {
            'event-id': message.envelope.event_id,
            'event-type': message.envelope.event_type,
            // PRD §14 — the request id rides in the message so async consumers log
            // under the same id as the HTTP request that caused the event.
            'x-request-id': message.envelope.request_id ?? '',
          },
        });
        byTopic.set(message.topic, list);
      }

      try {
        await producer.sendBatch({
          topicMessages: [...byTopic].map(([topic, msgs]) => ({ topic, messages: msgs })),
          acks: -1, // all in-sync replicas
        });
      } catch (error) {
        /*
         * Drop the connection on any send failure.
         *
         * After a broker outage a kafkajs producer can be left holding stale
         * broker metadata and keep failing against an address that has come back.
         * Discarding it means the next relay cycle reconnects and rediscovers the
         * cluster, so recovery is driven by our own retry loop rather than by
         * hoping the client heals itself.
         *
         * Safe to do unconditionally: the outbox rows were never marked published,
         * so the next cycle republishes them.
         */
        try {
          await producer.disconnect();
        } catch {
          // Already broken; nothing useful to report from a failed disconnect.
        }
        producer = null;
        throw error;
      }
    },

    disconnect: async () => {
      if (producer !== null) {
        await producer.disconnect();
        producer = null;
      }
    },
  };
}
