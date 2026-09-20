import type { Redis } from '@ticketing/http';
import { activeQueues, admitBatch } from './queue.js';

export interface AdmitterLogger {
  debug: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
}

/**
 * PRD §12 — the admitter loop: release N users per second from the head of each
 * queue.
 *
 * This is pure rate shaping. It protects the seat services from a thundering herd;
 * it does not protect a seat. If it stops running, nobody is admitted and the
 * waiting room stalls — which is a availability problem, never a correctness one,
 * and the fail-open path covers the case where Redis itself is gone.
 */
export function startAdmitter(options: {
  redis: Redis;
  ratePerSecond: number;
  intervalMs: number;
  admissionTtlSeconds: number;
  logger: AdmitterLogger;
}): () => void {
  // Scale the per-tick batch to the tick length, so changing the interval does
  // not silently change the admission rate.
  const perTick = Math.max(1, Math.round((options.ratePerSecond * options.intervalMs) / 1000));
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const eventId of await activeQueues(options.redis)) {
        const admitted = await admitBatch(options.redis, {
          eventId,
          count: perTick,
          ttlSeconds: options.admissionTtlSeconds,
        });
        if (admitted.length > 0) {
          options.logger.debug({ eventId, admitted: admitted.length }, 'admitted a batch from the waiting room');
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
