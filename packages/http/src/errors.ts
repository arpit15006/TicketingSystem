import { ErrorCode, type ErrorCodeName } from '@ticketing/contracts';

/**
 * A deliberate, expected failure with a chosen HTTP status.
 *
 * The distinction matters for idempotency (ADR-009): an AppError is a *decision*
 * — "these seats are gone" — so replaying the same key must replay that same
 * decision. An unexpected Error is a crash, and replaying the key must be allowed
 * to try again rather than permanently caching a stack trace.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeName;
  readonly details: unknown;

  constructor(statusCode: number, code: ErrorCodeName, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const seatsUnavailable = (requestedSeatIds: string[], unavailableSeatIds: string[]): AppError =>
  new AppError(409, ErrorCode.seatsUnavailable, 'One or more requested seats are no longer available', {
    requestedSeatIds,
    unavailableSeatIds,
  });

/** PRD §8.3 — finalization found fewer rows than expected: the seat was lost. */
export const seatLost = (holdId: string, expected: number, actual: number): AppError =>
  new AppError(410, ErrorCode.seatLost, 'The hold is no longer valid; seats were lost', { holdId, expected, actual });

export const holdNotFound = (holdId: string): AppError =>
  new AppError(404, ErrorCode.holdNotFound, 'Hold not found', { holdId });

export const holdNotActive = (holdId: string, status: string): AppError =>
  new AppError(409, ErrorCode.holdNotActive, 'Hold is not active', { holdId, status });

export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError(401, ErrorCode.unauthorized, message);
