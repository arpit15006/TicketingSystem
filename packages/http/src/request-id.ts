import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';
import type { FastifyPluginCallback } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** PRD §14 — one ID greppable across every service for a single booking. */
    requestId: string;
  }
}

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * PRD §14. The gateway mints the ID; every downstream service reuses the inbound
 * header and only generates one when it is genuinely the entry point. Generating a
 * fresh ID here unconditionally would break the end-to-end trace the README promises.
 */
export const requestIdPlugin: FastifyPluginCallback = fp((fastify, _opts, done) => {
  fastify.decorateRequest('requestId', '');

  fastify.addHook('onRequest', (req, reply, next) => {
    const inbound = req.headers[REQUEST_ID_HEADER];
    const requestId = (Array.isArray(inbound) ? inbound[0] : inbound)?.trim() || randomUUID();

    req.requestId = requestId;
    reply.header(REQUEST_ID_HEADER, requestId);
    req.log = req.log.child({ requestId });
    next();
  });

  done();
}, { name: 'request-id', fastify: '5.x' });
