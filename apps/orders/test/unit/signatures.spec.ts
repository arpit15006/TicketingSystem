import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyCheckoutSignature, verifyWebhookSignature } from '../../src/signatures.js';

const SECRET = 'test_key_secret';

describe('Razorpay signature verification', () => {
  it('accepts a correct checkout signature', () => {
    const orderId = 'order_abc';
    const paymentId = 'pay_xyz';
    const signature = createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');

    expect(verifyCheckoutSignature({ razorpayOrderId: orderId, razorpayPaymentId: paymentId, signature, keySecret: SECRET })).toBe(true);
  });

  it('rejects a signature for a different payment or order', () => {
    const signature = createHmac('sha256', SECRET).update('order_abc|pay_xyz').digest('hex');

    expect(verifyCheckoutSignature({ razorpayOrderId: 'order_abc', razorpayPaymentId: 'pay_OTHER', signature, keySecret: SECRET })).toBe(false);
    expect(verifyCheckoutSignature({ razorpayOrderId: 'order_OTHER', razorpayPaymentId: 'pay_xyz', signature, keySecret: SECRET })).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const signature = createHmac('sha256', 'wrong_secret').update('order_abc|pay_xyz').digest('hex');
    expect(verifyCheckoutSignature({ razorpayOrderId: 'order_abc', razorpayPaymentId: 'pay_xyz', signature, keySecret: SECRET })).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    for (const signature of ['', 'not-hex', 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(() =>
        verifyCheckoutSignature({ razorpayOrderId: 'o', razorpayPaymentId: 'p', signature, keySecret: SECRET }),
      ).not.toThrow();
      expect(verifyCheckoutSignature({ razorpayOrderId: 'o', razorpayPaymentId: 'p', signature, keySecret: SECRET })).toBe(false);
    }
  });

  it('accepts a webhook signature over the exact bytes received', () => {
    const rawBody = Buffer.from('{"event":"payment.authorized","payload":{"a":1,"b":2}}', 'utf8');
    const signature = createHmac('sha256', SECRET).update(rawBody).digest('hex');
    expect(verifyWebhookSignature({ rawBody, signature, webhookSecret: SECRET })).toBe(true);
  });

  /**
   * The bug PRD §10.3 calls "the single most common implementation bug": parsing
   * the JSON and re-serialising it before verifying. The bytes change, so the
   * digest changes, and legitimate traffic starts failing verification.
   */
  it('rejects a body that was parsed and re-serialised', () => {
    const original = Buffer.from('{"event":"payment.authorized","payload":{"a":1,"b":2}}', 'utf8');
    const signature = createHmac('sha256', SECRET).update(original).digest('hex');

    const reordered = Buffer.from(JSON.stringify({ payload: { b: 2, a: 1 }, event: 'payment.authorized' }), 'utf8');
    const reindented = Buffer.from(JSON.stringify(JSON.parse(original.toString()), null, 2), 'utf8');

    expect(verifyWebhookSignature({ rawBody: reordered, signature, webhookSecret: SECRET })).toBe(false);
    expect(verifyWebhookSignature({ rawBody: reindented, signature, webhookSecret: SECRET })).toBe(false);
  });

  it('is unaffected by a trailing newline being added', () => {
    const original = Buffer.from('{"event":"x"}', 'utf8');
    const signature = createHmac('sha256', SECRET).update(original).digest('hex');
    const withNewline = Buffer.from('{"event":"x"}\n', 'utf8');
    expect(verifyWebhookSignature({ rawBody: withNewline, signature, webhookSecret: SECRET })).toBe(false);
  });
});
