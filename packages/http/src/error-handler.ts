import fp from 'fastify-plugin';
import type { FastifyPluginCallback } from 'fastify';
import { ErrorCode, type ApiError } from '@ticketing/contracts';
import { AppError } from './errors.js';

function hasNumber<K extends string>(value: unknown, key: K): value is Record<K, number> {
  return typeof value === 'object' && value !== null && typeof (value as Record<K, unknown>)[key] === 'number';
}

function hasString<K extends string>(value: unknown, key: K): value is Record<K, string> {
  return typeof value === 'object' && value !== null && typeof (value as Record<K, unknown>)[key] === 'string';
}

/**
 * Single error shape for every service, so a client never has to guess.
 * Unexpected errors are logged in full and reported without internals — the
 * requestId is the handle a user quotes and an operator greps.
 */
export const errorHandlerPlugin: FastifyPluginCallback = fp((fastify, _opts, done) => {
  fastify.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      const body: ApiError = {
        code: error.code,
        message: error.message,
        requestId: req.requestId,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
      req.log.info({ code: error.code, statusCode: error.statusCode, details: error.details }, 'request rejected');
      return reply.status(error.statusCode).send(body);
    }

    // Fastify's own schema validation failures arrive as plain objects carrying a
    // statusCode, so narrow rather than assuming a shape.
    const statusCode = hasNumber(error, 'statusCode') ? error.statusCode : undefined;
    if (statusCode !== undefined && statusCode < 500) {
      const body: ApiError = {
        code: ErrorCode.validationFailed,
        message: hasString(error, 'message') ? error.message : 'Request validation failed',
        requestId: req.requestId,
      };
      return reply.status(statusCode).send(body);
    }

    req.log.error({ err: error }, 'unhandled error');
    const body: ApiError = {
      code: ErrorCode.internal,
      message: 'Internal server error',
      requestId: req.requestId,
    };
    return reply.status(500).send(body);
  });

  done();
}, { name: 'error-handler', fastify: '5.x' });
