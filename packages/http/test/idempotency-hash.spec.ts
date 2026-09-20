import { describe, it, expect } from 'vitest';
import { hashRequest } from '../src/idempotency.js';

/** ADR-009 — the body hash is what makes key reuse detectable. */
describe('hashRequest', () => {
  it('ignores key order, because re-serialising a body is not a new request', () => {
    const a = hashRequest('POST', '/reservations', { eventId: 'e1', seatIds: ['s1', 's2'] });
    const b = hashRequest('POST', '/reservations', { seatIds: ['s1', 's2'], eventId: 'e1' });
    expect(a).toBe(b);
  });

  it('is sensitive to array order, because seat order is meaningful input', () => {
    const a = hashRequest('POST', '/reservations', { seatIds: ['s1', 's2'] });
    const b = hashRequest('POST', '/reservations', { seatIds: ['s2', 's1'] });
    expect(a).not.toBe(b);
  });

  it('distinguishes a different body', () => {
    const a = hashRequest('POST', '/reservations', { seatIds: ['s1'] });
    const b = hashRequest('POST', '/reservations', { seatIds: ['s9'] });
    expect(a).not.toBe(b);
  });

  it('distinguishes the same body sent to a different route or method', () => {
    const body = { seatIds: ['s1'] };
    expect(hashRequest('POST', '/reservations', body)).not.toBe(hashRequest('POST', '/orders', body));
    expect(hashRequest('POST', '/reservations', body)).not.toBe(hashRequest('PUT', '/reservations', body));
  });

  it('handles nested objects and nulls without throwing', () => {
    expect(() => hashRequest('POST', '/x', { a: { b: [1, null, { c: 2 }] }, d: null })).not.toThrow();
  });
});
