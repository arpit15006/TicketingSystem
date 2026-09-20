import { createServer, type Server, type ServerResponse } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';

export interface FakePayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  captured: boolean;
}

export interface FakeRazorpay {
  baseUrl: string;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** Simulate the customer completing Checkout: creates an authorized payment. */
  authorize: (razorpayOrderId: string) => FakePayment;
  /** The signature Razorpay's Checkout callback would carry (PRD §10.1.7). */
  signCheckout: (razorpayOrderId: string, paymentId: string) => string;
  /** A signed webhook delivery: exact bytes plus the matching signature header. */
  buildWebhook: (event: string, payload: unknown, eventId?: string) => { body: string; signature: string; eventId: string };
  getPayment: (paymentId: string) => FakePayment | undefined;
  captureCount: (paymentId: string) => number;
  refundCount: (paymentId: string) => number;
  orderCount: () => number;
  /** Force the next N API calls to fail, for failure-path tests. */
  failNextCalls: (count: number) => void;
  stop: () => Promise<void>;
}

/**
 * A stand-in for Razorpay's HTTP API.
 *
 * Only the *endpoint* is substituted. The service under test still uses its real
 * `createRazorpayClient`, so the Basic auth header, request bodies, status handling
 * and JSON parsing are all exercised — and the HMAC signatures it produces are
 * computed with the real algorithm and a real secret, so signature verification is
 * never weakened for testability.
 *
 * Razorpay itself cannot be called from CI: it is a third party, it is not
 * deterministic, and a test that depends on someone else's uptime is not a proof.
 */
export async function startFakeRazorpay(options: { keyId?: string; keySecret?: string; webhookSecret?: string } = {}): Promise<FakeRazorpay> {
  const keyId = options.keyId ?? 'rzp_test_fake';
  const keySecret = options.keySecret ?? 'fake_key_secret';
  const webhookSecret = options.webhookSecret ?? 'fake_webhook_secret';
  const expectedAuth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  const orders = new Map<string, { id: string; amount: number; currency: string; receipt: string; payment_capture: number }>();
  const payments = new Map<string, FakePayment>();
  const captures = new Map<string, number>();
  const refunds = new Map<string, number>();
  let failCalls = 0;

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      const raw = Buffer.concat(chunks).toString('utf8');
      const body: Record<string, unknown> = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);

      // Razorpay authenticates with HTTP Basic; a client that gets this wrong
      // should fail here rather than silently "work" against a permissive fake.
      if (req.headers.authorization !== expectedAuth) {
        send(res, 401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
        return;
      }

      if (failCalls > 0) {
        failCalls -= 1;
        send(res, 502, { error: { code: 'SERVER_ERROR', description: 'simulated upstream failure' } });
        return;
      }

      if (req.method === 'POST' && url === '/v1/orders') {
        const id = `order_${randomBytes(8).toString('hex')}`;
        const order = {
          id,
          amount: Number(body['amount']),
          currency: String(body['currency']),
          receipt: String(body['receipt'] ?? ''),
          payment_capture: Number(body['payment_capture'] ?? 1),
        };
        orders.set(id, order);
        send(res, 200, { ...order, status: 'created', entity: 'order' });
        return;
      }

      const captureMatch = /^\/v1\/payments\/([^/]+)\/capture$/.exec(url);
      if (req.method === 'POST' && captureMatch !== null) {
        const paymentId = captureMatch[1]!;
        const payment = payments.get(paymentId);
        if (payment === undefined) {
          send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'payment not found' } });
          return;
        }
        if (payment.status === 'captured') {
          // Razorpay rejects a second capture; the fake must too, or the test
          // would not catch a double-capture bug.
          send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'payment already captured' } });
          return;
        }
        payment.status = 'captured';
        payment.captured = true;
        captures.set(paymentId, (captures.get(paymentId) ?? 0) + 1);
        send(res, 200, payment);
        return;
      }

      const refundMatch = /^\/v1\/payments\/([^/]+)\/refund$/.exec(url);
      if (req.method === 'POST' && refundMatch !== null) {
        const paymentId = refundMatch[1]!;
        const payment = payments.get(paymentId);
        if (payment === undefined) {
          send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'payment not found' } });
          return;
        }
        payment.status = 'refunded';
        refunds.set(paymentId, (refunds.get(paymentId) ?? 0) + 1);
        send(res, 200, { id: `rfnd_${randomBytes(8).toString('hex')}`, payment_id: paymentId, amount: Number(body['amount']), status: 'processed' });
        return;
      }

      const fetchMatch = /^\/v1\/payments\/([^/]+)$/.exec(url);
      if (req.method === 'GET' && fetchMatch !== null) {
        const payment = payments.get(fetchMatch[1]!);
        if (payment === undefined) {
          send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'payment not found' } });
          return;
        }
        send(res, 200, payment);
        return;
      }

      send(res, 404, { error: { code: 'NOT_FOUND', description: url } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake razorpay did not bind a port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    keyId,
    keySecret,
    webhookSecret,

    authorize: (razorpayOrderId) => {
      const order = orders.get(razorpayOrderId);
      if (order === undefined) throw new Error(`unknown razorpay order ${razorpayOrderId}`);
      const payment: FakePayment = {
        id: `pay_${randomBytes(8).toString('hex')}`,
        order_id: razorpayOrderId,
        amount: order.amount,
        currency: order.currency,
        // ADR-007 — authorized, NOT captured. Capture is a separate, later step.
        status: 'authorized',
        captured: false,
      };
      payments.set(payment.id, payment);
      return payment;
    },

    signCheckout: (razorpayOrderId, paymentId) =>
      createHmac('sha256', keySecret).update(`${razorpayOrderId}|${paymentId}`).digest('hex'),

    buildWebhook: (event, payload, eventId) => {
      const body = JSON.stringify({ event, payload });
      return {
        body,
        // Signed over the exact bytes that will be sent — which is the whole
        // point of the raw-body requirement in PRD §10.3.
        signature: createHmac('sha256', webhookSecret).update(body).digest('hex'),
        eventId: eventId ?? `evt_${randomBytes(8).toString('hex')}`,
      };
    },

    getPayment: (paymentId) => payments.get(paymentId),
    captureCount: (paymentId) => captures.get(paymentId) ?? 0,
    refundCount: (paymentId) => refunds.get(paymentId) ?? 0,
    orderCount: () => orders.size,
    failNextCalls: (count) => {
      failCalls = count;
    },
    stop: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
