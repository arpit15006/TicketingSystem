/**
 * Shared types and event-schema declarations. PRD §5: this package holds no runtime
 * logic — only types and the constants that name things across service boundaries.
 * Anything executable belongs in the service that owns the behaviour.
 */

export {
  ROLES,
  ACTIONS,
  ROLE_ACTIONS,
  ACTION_SCOPE,
  formatGrant,
  parseGrant,
  type Role,
  type Action,
  type ResourceType,
  type RoleGrant,
  type AccessTokenClaims,
} from './auth.js';

/* ------------------------------------------------------------------ seats */

/** PRD §7.1 — `seat_status` enum, mirrored in TypeScript. */
export const SEAT_STATUSES = ['available', 'held', 'sold', 'blocked'] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

export const HOLD_STATUSES = ['active', 'converted', 'expired', 'released'] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

/** PRD §8.4 — allocation mode. `segmented` is Phase 8 and strictly additive. */
export const ALLOCATION_MODES = ['whole', 'segmented'] as const;
export type AllocationMode = (typeof ALLOCATION_MODES)[number];

/* ----------------------------------------------------------------- orders */

/** PRD §7.2 — `order_status` enum. */
export const ORDER_STATUSES = [
  'created',
  'awaiting_payment',
  'payment_authorized',
  'confirmed',
  'compensating',
  'refunded_seat_lost',
  'failed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/* ------------------------------------------------------- kafka / outbox */

/** PRD §11 — topic naming is `ticketing.<aggregate>.<event>`. */
export const Topics = {
  seatHeld: 'ticketing.seat.held',
  seatSold: 'ticketing.seat.sold',
  seatReleased: 'ticketing.seat.released',
  orderConfirmed: 'ticketing.order.confirmed',
  orderCompensated: 'ticketing.order.compensated',
  paymentFailed: 'ticketing.payment.failed',
} as const;

export type TopicName = (typeof Topics)[keyof typeof Topics];

/** Outbox `event_type` values. One per topic; the relay maps type → topic. */
export const EventType = {
  SeatHeld: 'SeatHeld',
  SeatSold: 'SeatSold',
  SeatReleased: 'SeatReleased',
  OrderConfirmed: 'OrderConfirmed',
  OrderCompensated: 'OrderCompensated',
  PaymentFailed: 'PaymentFailed',
} as const;

export type EventTypeName = (typeof EventType)[keyof typeof EventType];

export const EVENT_TYPE_TO_TOPIC: Readonly<Record<EventTypeName, TopicName>> = {
  SeatHeld: Topics.seatHeld,
  SeatSold: Topics.seatSold,
  SeatReleased: Topics.seatReleased,
  OrderConfirmed: Topics.orderConfirmed,
  OrderCompensated: Topics.orderCompensated,
  PaymentFailed: Topics.paymentFailed,
};

/**
 * PRD §11 — every event carries `event_id`, `occurred_at` and `request_id`.
 * `event_id` is what consumers dedupe on (ADR-005: delivery is at-least-once).
 */
export interface EventEnvelope<T = unknown> {
  event_id: string;
  event_type: EventTypeName;
  aggregate_id: string;
  occurred_at: string;
  request_id: string | null;
  payload: T;
}

export interface SeatHeldPayload {
  holdId: string;
  eventId: string;
  userId: string;
  seatIds: string[];
  expiresAt: string;
}

export interface SeatSoldPayload {
  holdId: string;
  eventId: string;
  orderId: string;
  seatIds: string[];
}

export interface SeatReleasedPayload {
  holdId: string;
  eventId: string;
  seatIds: string[];
  reason: 'released' | 'expired';
}

/* -------------------------------------------------------- api contracts */

/** Stable machine-readable error codes. Clients branch on these, never on prose. */
export const ErrorCode = {
  validationFailed: 'VALIDATION_FAILED',
  seatsUnavailable: 'SEATS_UNAVAILABLE',
  holdNotFound: 'HOLD_NOT_FOUND',
  holdNotActive: 'HOLD_NOT_ACTIVE',
  seatLost: 'SEAT_LOST',
  idempotencyKeyReused: 'IDEMPOTENCY_KEY_REUSED',
  idempotentRequestInProgress: 'IDEMPOTENT_REQUEST_IN_PROGRESS',
  forbidden: 'FORBIDDEN',
  emailAlreadyRegistered: 'EMAIL_ALREADY_REGISTERED',
  invalidCredentials: 'INVALID_CREDENTIALS',
  invalidRefreshToken: 'INVALID_REFRESH_TOKEN',
  refreshTokenReused: 'REFRESH_TOKEN_REUSED',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
  unauthorized: 'UNAUTHORIZED',
  internal: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiError {
  code: ErrorCodeName;
  message: string;
  requestId: string;
  details?: unknown;
}

export interface HoldResponse {
  holdId: string;
  eventId: string;
  seatIds: string[];
  expiresAt: string;
  status: HoldStatus;
}

/** `409` body for a lost seat race — tells the client exactly which seats went. */
export interface SeatsUnavailableDetails {
  requestedSeatIds: string[];
  unavailableSeatIds: string[];
}
