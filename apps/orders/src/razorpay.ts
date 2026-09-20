/**
 * Razorpay Orders API client (ADR-007).
 *
 * Thin on purpose: one place that knows Razorpay's wire format, so the order state
 * machine can be read without HTTP details, and so tests can point the same client
 * at a stand-in endpoint without any of the client's own code being bypassed.
 */

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string;
}

export interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  /** created | authorized | captured | refunded | failed */
  status: string;
  captured?: boolean;
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: string;
}

export class RazorpayError extends Error {
  readonly statusCode: number;
  readonly body: unknown;
  constructor(statusCode: number, message: string, body: unknown) {
    super(message);
    this.name = 'RazorpayError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

export interface RazorpayClient {
  createOrder: (args: { amountPaise: number; currency: string; receipt: string; notes?: Record<string, string> }) => Promise<RazorpayOrder>;
  fetchPayment: (paymentId: string) => Promise<RazorpayPayment>;
  capturePayment: (args: { paymentId: string; amountPaise: number; currency: string }) => Promise<RazorpayPayment>;
  refundPayment: (args: { paymentId: string; amountPaise: number }) => Promise<RazorpayRefund>;
}

export interface HttpRazorpayClientOptions {
  baseUrl: string;
  keyId: string;
  keySecret: string;
  timeoutMs?: number;
}

export function createRazorpayClient(options: HttpRazorpayClientOptions): RazorpayClient {
  const auth = Buffer.from(`${options.keyId}:${options.keySecret}`).toString('base64');
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${auth}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      const description =
        typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? JSON.stringify((parsed as { error: unknown }).error)
          : text;
      throw new RazorpayError(response.status, `Razorpay ${method} ${path} failed: ${description}`, parsed);
    }

    return parsed as T;
  }

  return {
    createOrder: async (args) =>
      call<RazorpayOrder>('POST', '/v1/orders', {
        amount: args.amountPaise,
        currency: args.currency,
        receipt: args.receipt,
        // ADR-007 — MANUAL CAPTURE. Authorizing without capturing is what maps
        // onto the hold model: if the seat is lost before capture, no money ever
        // moved and there is nothing to refund.
        payment_capture: 0,
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      }),

    fetchPayment: async (paymentId) => call<RazorpayPayment>('GET', `/v1/payments/${paymentId}`),

    capturePayment: async (args) =>
      call<RazorpayPayment>('POST', `/v1/payments/${args.paymentId}/capture`, {
        amount: args.amountPaise,
        currency: args.currency,
      }),

    refundPayment: async (args) =>
      call<RazorpayRefund>('POST', `/v1/payments/${args.paymentId}/refund`, { amount: args.amountPaise }),
  };
}
