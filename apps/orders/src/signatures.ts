import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay signature verification.
 *
 * Kept in its own module with no dependencies so it can be read and tested in
 * isolation — this is the code that decides whether a payment claim is real, and
 * it is the single most commonly botched part of a Razorpay integration.
 */

/** Constant-time compare. A `===` here leaks the signature one byte at a time. */
function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * PRD §10.1.7 — the Checkout callback signature:
 * `HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)`.
 *
 * Without this, anyone who knows an order id could POST a made-up payment id and
 * claim a seat. The client's "success" callback proves nothing on its own.
 */
export function verifyCheckoutSignature(args: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
  keySecret: string;
}): boolean {
  const expected = createHmac('sha256', args.keySecret)
    .update(`${args.razorpayOrderId}|${args.razorpayPaymentId}`)
    .digest('hex');
  return safeEqualHex(expected, args.signature);
}

/**
 * PRD §10.3 — the webhook signature: `HMAC_SHA256(rawBody, webhook_secret)`.
 *
 * `rawBody` must be the EXACT bytes Razorpay sent. Parsing the JSON and
 * re-serialising it reorders keys and changes whitespace, which produces a
 * different digest and a verification failure that looks like an attack. This
 * function therefore takes a Buffer and never a parsed object — the type makes the
 * mistake hard to make.
 */
export function verifyWebhookSignature(args: { rawBody: Buffer; signature: string; webhookSecret: string }): boolean {
  const expected = createHmac('sha256', args.webhookSecret).update(args.rawBody).digest('hex');
  return safeEqualHex(expected, args.signature);
}
