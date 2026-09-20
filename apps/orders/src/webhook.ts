import type { FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { LogEvent } from '@ticketing/logger';
import { PgError, pgErrorCode } from '@ticketing/http';
import { verifyWebhookSignature } from './signatures.js';
import { findOrderByRazorpayOrderId, settleOrder, type SettleDeps } from './orders.js';

export interface WebhookPluginOptions {
  pool: Pool;
  webhookSecret: string;
  settleDeps: SettleDeps;
}

interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; status?: string } };
    refund?: { entity?: { id?: string; payment_id?: string } };
  };
}

/**
 * PRD §10.3 — the Razorpay webhook.
 *
 * Registered as its own encapsulated plugin so the content-type parser below
 * applies ONLY here. Everywhere else in this service, JSON is parsed normally.
 *
 * The parser hands the route the raw `Buffer` and does not parse it. That is the
 * literal reading of the guardrail "never parse the webhook body before verifying
 * its signature", and it is not pedantry: Razorpay HMACs the exact bytes it sent,
 * so parsing to an object and re-serialising reorders keys and changes whitespace,
 * producing a different digest. Verification then fails on legitimate traffic and
 * looks like an attack. This is the single most common bug in Razorpay
 * integrations, which is why the route physically cannot see a parsed body until
 * after the signature has been checked.
 */
export const webhookPlugin: FastifyPluginAsync<WebhookPluginOptions> = async (fastify, opts) => {
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  fastify.post('/webhooks/razorpay', async (req, reply) => {
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      req.log.error('webhook body was not delivered as a raw buffer');
      return reply.status(400).send({ ok: false });
    }

    const signatureHeader = req.headers['x-razorpay-signature'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const eventIdHeader = req.headers['x-razorpay-event-id'];
    const eventId = Array.isArray(eventIdHeader) ? eventIdHeader[0] : eventIdHeader;

    if (signature === undefined || signature === '') {
      return reply.status(400).send({ ok: false, reason: 'missing signature' });
    }

    // ── Verify FIRST. Nothing below has looked at the contents yet. ─────────
    if (!verifyWebhookSignature({ rawBody, signature, webhookSecret: opts.webhookSecret })) {
      req.log.warn({ eventId }, 'webhook signature verification failed');
      return reply.status(400).send({ ok: false, reason: 'invalid signature' });
    }

    if (eventId === undefined || eventId === '') {
      return reply.status(400).send({ ok: false, reason: 'missing event id' });
    }

    // ── Only now is it safe to interpret the bytes ──────────────────────────
    let parsed: RazorpayWebhookBody;
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhookBody;
    } catch {
      return reply.status(400).send({ ok: false, reason: 'invalid json' });
    }

    /*
     * ADR-009 — claim the event id BEFORE processing.
     *
     * The insert is the dedupe. A duplicate-key violation means another delivery
     * of this exact event already claimed it, so this one returns 200 and does
     * nothing. Checking-then-inserting instead would leave a window in which two
     * concurrent deliveries both see "not processed" and both issue a ticket.
     */
    try {
      await opts.pool.query(`INSERT INTO processed_webhooks (event_id, payload) VALUES ($1, $2)`, [
        eventId,
        rawBody.toString('utf8'),
      ]);
    } catch (error) {
      if (pgErrorCode(error) === PgError.uniqueViolation) {
        req.log.info({ event: LogEvent.webhookDuplicateIgnored, eventId }, 'duplicate webhook ignored');
        return reply.status(200).send({ ok: true, duplicate: true });
      }
      throw error;
    }

    const eventName = parsed.event ?? 'unknown';
    const payment = parsed.payload?.payment?.entity;

    try {
      switch (eventName) {
        case 'payment.authorized':
        case 'payment.captured': {
          if (payment?.id === undefined || payment.order_id === undefined) break;

          const order = await findOrderByRazorpayOrderId(opts.pool, payment.order_id);
          if (order === null) {
            req.log.warn({ eventId, razorpayOrderId: payment.order_id }, 'webhook for an unknown order');
            break;
          }

          // The same settlement the client callback drives. A customer who closed
          // the browser still gets their ticket, because the webhook finishes the job.
          await settleOrder(opts.settleDeps, { order, paymentId: payment.id, requestId: req.requestId });
          break;
        }

        case 'payment.failed': {
          if (payment?.order_id === undefined) break;
          const order = await findOrderByRazorpayOrderId(opts.pool, payment.order_id);
          if (order === null || order.status === 'confirmed') break;

          await opts.pool.query(
            `UPDATE orders SET status = 'failed', failure_reason = 'payment_failed', updated_at = now()
             WHERE order_id = $1 AND status NOT IN ('confirmed', 'refunded_seat_lost')`,
            [order.order_id],
          );
          break;
        }

        case 'refund.processed': {
          const refund = parsed.payload?.refund?.entity;
          if (refund?.payment_id === undefined) break;
          const found = await opts.pool.query<{ order_id: string }>(
            `SELECT order_id FROM orders WHERE razorpay_payment_id = $1`,
            [refund.payment_id],
          );
          const orderId = found.rows[0]?.order_id;
          if (orderId !== undefined) req.log.info({ orderId, refundId: refund.id }, 'refund processed');
          break;
        }

        default:
          // PRD §10.3 — always 200 for events we do not handle. Returning an error
          // would make Razorpay retry forever over something we chose to ignore.
          req.log.debug({ eventName }, 'unhandled webhook event type');
          break;
      }
    } catch (error) {
      // The event id is already claimed, so a retry would be deduped away. Surface
      // a 500 so Razorpay does NOT consider it delivered... except it would be
      // deduped. So release the claim and let the retry do real work.
      await opts.pool.query(`DELETE FROM processed_webhooks WHERE event_id = $1`, [eventId]);
      req.log.error({ err: error, eventId, eventName }, 'webhook processing failed; claim released for retry');
      return reply.status(500).send({ ok: false });
    }

    return reply.status(200).send({ ok: true });
  });
};
