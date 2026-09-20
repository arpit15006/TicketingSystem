import { Kafka, logLevel, type Consumer } from 'kafkajs';
import type { EventEnvelope, TopicName } from '@ticketing/contracts';

export interface ConsumerLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface ConsumerOptions {
  brokers: string[];
  clientId: string;
  groupId: string;
  topics: readonly TopicName[];
  logger: ConsumerLogger;
  /**
   * Handle one event. MUST be idempotent — delivery is at-least-once (ADR-005),
   * so this will be called more than once for the same `event_id`.
   */
  handle: (envelope: EventEnvelope, context: { requestId: string | null }) => Promise<void>;
}

export interface EventConsumer {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createKafkaConsumer(options: ConsumerOptions): EventConsumer {
  const kafka = new Kafka({
    clientId: options.clientId,
    brokers: options.brokers,
    logLevel: logLevel.NOTHING,
    connectionTimeout: 3_000,
    retry: { retries: 5, initialRetryTime: 200, maxRetryTime: 2_000 },
  });

  let consumer: Consumer | null = null;

  return {
    start: async () => {
      consumer = kafka.consumer({ groupId: options.groupId, sessionTimeout: 10_000 });
      await consumer.connect();
      for (const topic of options.topics) {
        await consumer.subscribe({ topic, fromBeginning: true });
      }

      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const raw = message.value?.toString('utf8');
          if (raw === undefined) return;

          let envelope: EventEnvelope;
          try {
            envelope = JSON.parse(raw) as EventEnvelope;
          } catch (error) {
            // A message we cannot parse will never become parseable. Log it and
            // move on rather than blocking the partition forever.
            options.logger.error({ err: error, topic, partition }, 'skipping unparseable message');
            return;
          }

          try {
            await options.handle(envelope, { requestId: envelope.request_id });
          } catch (error) {
            // Rethrowing makes kafkajs retry without advancing the offset, which
            // is right for a transient failure: the alternative is losing the event.
            options.logger.error(
              { err: error, eventId: envelope.event_id, topic },
              'handler failed; offset not advanced',
            );
            throw error;
          }
        },
      });
    },

    stop: async () => {
      if (consumer !== null) {
        await consumer.disconnect();
        consumer = null;
      }
    },
  };
}
