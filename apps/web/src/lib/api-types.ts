/**
 * The wire shapes the gateway actually returns.
 *
 * Hand-written rather than generated, and deliberately narrow: these describe only
 * what the UI reads. They are a contract with the services, so each one names the
 * route it came from — if a service changes, the grep starts here.
 */

/** Every service returns this exact error body (packages/http/src/error-handler.ts). */
export interface ApiErrorBody {
  code: string
  message: string
  requestId: string
  details?: unknown
}

/** PRD §8.1 — the 409 body names exactly which seats were lost. */
export interface SeatsUnavailableDetails {
  requestedSeatIds: string[]
  unavailableSeatIds: string[]
}

export type Role =
  | "attendee"
  | "organizer"
  | "venue_admin"
  | "scanner"
  | "platform_admin"

export interface RoleGrant {
  role: Role
  resourceType: "event" | "venue" | null
  resourceId: string | null
}

/* ─────────────────────────────── identity ────────────────────────────────── */

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

/** `POST /identity/auth/login` and `/auth/register`. */
export interface AuthResult extends TokenPair {
  userId: string
}

/** `GET /identity/me`. */
export interface CurrentUser {
  userId: string
  email: string
  fullName: string
  roles: RoleGrant[]
}

/* ──────────────────────────────── catalog ────────────────────────────────── */

export type EventStatus = "draft" | "published" | "onsale" | "closed"

/** A row from `GET /catalog/events` and `/events/mine` — snake_case; catalog returns rows. */
export interface EventSummary {
  event_id: string
  venue_id: string
  organizer_id: string
  title: string
  status: EventStatus
  starts_at: string
  onsale_at: string | null
  waiting_room_enabled: boolean
  venue_name: string
  venue_city: string
  /** Cheapest tier, for "from ₹X". Null until a tier exists. */
  min_price_paise: number | null
}

/** `POST /catalog/venues` and the venue block on a detail page. */
export interface Venue {
  venue_id: string
  name: string
  address: string
  city: string
}

export interface SeatTier {
  tier_id: string
  name: string
  price_paise: number
}

export interface SeatmapSection {
  section_id: string
  tier_id: string
  name: string
  row_count: number
  seats_per_row: number
  geometry: Record<string, unknown>
}

/** `GET /catalog/events/:id` — the summary plus its tiers and sections. */
export interface EventDetail extends EventSummary {
  organizer_id: string
  description: string
  hold_duration_seconds: number
  tiers: SeatTier[]
  sections: SeatmapSection[]
}

/* ────────────────────────────── reservation ──────────────────────────────── */

/** A free seat from `GET /availability`. Sold and live-held seats are absent. */
export interface AvailableSeat {
  seat_id: string
  section: string
  row_label: string
  seat_number: string
  tier_id: string
}

export interface AvailabilityResponse {
  eventId: string
  available: number
  seats: AvailableSeat[]
}

/** `POST /reservations` on success. */
export interface Hold {
  holdId: string
  eventId: string
  seatIds: string[]
  expiresAt: string
  status: "active" | "converted" | "released" | "expired"
}

/** `GET /reservations/:holdId` — the owner-scoped read (Phase 6a). */
export interface HoldDetail {
  holdId: string
  eventId: string
  userId: string
  status: string
  expiresAt: string
  seats: { seatId: string; tierId: string; status: string }[]
}

/** `GET /inventory/:eventId/sales` — the organizer dashboard aggregate. */
export interface SalesSummary {
  eventId: string
  total: number
  sold: number
  held: number
  available: number
}

/* ───────────────────────────────── orders ────────────────────────────────── */

export type OrderStatus =
  | "created"
  | "awaiting_payment"
  | "payment_authorized"
  | "confirmed"
  | "compensating"
  | "refunded_seat_lost"
  | "failed"
  | "cancelled"

/** `POST /orders` — carries everything Razorpay Checkout needs. */
export interface PlacedOrder {
  orderId: string
  holdId: string
  eventId: string
  seatIds: string[]
  amountPaise: number
  currency: string
  status: OrderStatus
  razorpayOrderId: string
  /** The publishable key id. The secret never leaves the orders service. */
  razorpayKeyId: string
}

export interface Ticket {
  ticket_id: string
  seat_id: string
  qr_token: string
  scanned_at: string | null
}

/** `GET /orders/:orderId`. */
export interface OrderDetail {
  orderId: string
  eventId: string
  holdId: string
  seatIds: string[]
  amountPaise: number
  status: OrderStatus
  failureReason: string | null
  /** Present so a reloaded checkout can reopen Razorpay without a second POST. */
  razorpayOrderId: string | null
  razorpayKeyId: string
  tickets: Ticket[]
}

/** One row of `GET /orders` — the caller's own bookings, newest first. */
export interface OrderSummary {
  orderId: string
  eventId: string
  seatCount: number
  amountPaise: number
  status: OrderStatus
  createdAt: string
  ticketCount: number
  scannedCount: number
}

/** `POST /tickets/scan` (Phase 6a). */
export interface ScanResult {
  ticketId: string
  eventId: string
  seatId: string
  admitted: boolean
  alreadyScanned: boolean
  scannedAt: string | null
}

/* ────────────────────────────── waiting room ─────────────────────────────── */

/** `POST /queue/:eventId/join` and `GET /queue/:eventId/status`. */
export interface QueueStatus {
  eventId: string
  admitted: boolean
  position: number
  total: number
  estimatedWaitSeconds: number
  /** ADR-012 — true when Redis is down and everyone is being let through. */
  degraded: boolean
  admissionToken?: string
}
