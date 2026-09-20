import type { Pool } from 'pg';
import { PgError, pgErrorCode, withTransaction } from '@ticketing/http';
import { EventType, type EventEnvelope } from '@ticketing/contracts';

export interface HandlerLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export type NotificationKind = 'order_confirmed' | 'order_compensated' | 'payment_failed' | 'seat_sold';

interface Rendered {
  kind: NotificationKind;
  userId: string | null;
  subject: string;
  body: string;
}

/**
 * Turns an event into the message a human would receive. PRD §2 rules out email
 * deliverability infrastructure, so "sending" is a log line and a stored row.
 */
function render(envelope: EventEnvelope): Rendered | null {
  const payload = envelope.payload as Record<string, unknown>;
  const userId = typeof payload['userId'] === 'string' ? payload['userId'] : null;
  const seatCount = Array.isArray(payload['seatIds']) ? (payload['seatIds'] as unknown[]).length : 0;

  switch (envelope.event_type) {
    case EventType.OrderConfirmed:
      return {
        kind: 'order_confirmed',
        userId,
        subject: 'Your tickets are confirmed',
        body: `Your booking is confirmed for ${seatCount} seat(s). Your tickets and QR codes are in your account.`,
      };

    case EventType.OrderCompensated:
      /*
       * PRD §10.4 — the message that has to be unambiguous.
       *
       * The user's payment was released and their seat is gone. Saying "your
       * order failed" would leave them wondering whether they had been charged,
       * so the money is addressed first and explicitly.
       */
      return {
        kind: 'order_compensated',
        userId,
        subject: 'Your payment was released — those seats were taken',
        body:
          `You have not been charged. The ${seatCount} seat(s) you selected were taken while your payment ` +
          `was being confirmed, so the payment was released back to you. Alternative seats are still available.`,
      };

    case EventType.PaymentFailed:
      return {
        kind: 'payment_failed',
        userId,
        subject: 'Your payment could not be completed',
        body: 'Your payment did not go through and no money was taken. Your seats have been released.',
      };

    case EventType.SeatSold:
      return {
        kind: 'seat_sold',
        userId: null,
        subject: 'Seats sold',
        body: `${seatCount} seat(s) sold for event ${String(payload['eventId'] ?? 'unknown')}.`,
      };

    default:
      return null;
  }
}

export interface HandleResult {
  status: 'processed' | 'duplicate' | 'ignored';
}

/**
 * ADR-005 — the idempotent consumer.
 *
 * `processed_events` is claimed by an INSERT *before* any side effect. A duplicate
 * key violation means another delivery of the same event already did the work, so
 * this one returns without sending anything.
 *
 * Both writes happen in one transaction, so "we recorded that we handled it" and
 * "we actually handled it" cannot come apart: if the notification insert fails, the
 * claim rolls back too and the event is genuinely retried.
 */
export async function handleEvent(
  pool: Pool,
  envelope: EventEnvelope,
  logger: HandlerLogger,
): Promise<HandleResult> {
  const rendered = render(envelope);

  try {
    return await withTransaction(pool, async (client) => {
      await client.query(`INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2)`, [
        envelope.event_id,
        envelope.event_type,
      ]);

      if (rendered === null) {
        logger.info({ eventId: envelope.event_id, eventType: envelope.event_type }, 'event recorded, nothing to send');
        return { status: 'ignored' };
      }

      await client.query(
        `INSERT INTO notifications (event_id, user_id, kind, subject, body, payload, request_id, delivered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          envelope.event_id,
          rendered.userId,
          rendered.kind,
          rendered.subject,
          rendered.body,
          JSON.stringify(envelope.payload),
          envelope.request_id,
        ],
      );

      // PRD §14 — logged under the requestId of the HTTP request that caused the
      // event, so one booking is greppable from the edge through to the email.
      logger.info(
        {
          requestId: envelope.request_id,
          eventId: envelope.event_id,
          kind: rendered.kind,
          userId: rendered.userId,
          subject: rendered.subject,
        },
        'notification sent',
      );

      return { status: 'processed' };
    });
  } catch (error) {
    if (pgErrorCode(error) === PgError.uniqueViolation) {
      logger.info({ eventId: envelope.event_id }, 'duplicate event ignored');
      return { status: 'duplicate' };
    }
    throw error;
  }
}
