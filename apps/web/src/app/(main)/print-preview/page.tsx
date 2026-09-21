import { PrintableTicket } from "@/components/printable-ticket"
import type { EventDetail, OrderDetail } from "@/lib/api-types"

const event = {
  event_id: "9e1a2b3c-0000-4000-8000-000000000001",
  venue_id: "v1",
  organizer_id: "o1",
  title: "Mumbai Indians vs Chennai Super Kings",
  status: "onsale",
  starts_at: "2026-09-29T13:30:00.000Z",
  onsale_at: null,
  waiting_room_enabled: true,
  venue_name: "Wankhede Stadium",
  venue_city: "Mumbai",
  min_price_paise: 150000,
  description: "",
  hold_duration_seconds: 300,
  tiers: [],
  sections: [],
} satisfies EventDetail

const order = {
  orderId: "fb30489a-4aa7-4a0d-950f-6221645695c1",
  eventId: event.event_id,
  holdId: "h1",
  seatIds: ["7bc32b40-e04c-4b3a-9f11-000000000001", "dd03e7f6-11ae-4c22-8a90-000000000002", "e46cec24-7da0-4d55-9b31-000000000003"],
  amountPaise: 1350000,
  status: "confirmed",
  failureReason: null,
  razorpayOrderId: null,
  razorpayKeyId: "",
  tickets: [
    { ticket_id: "7bc32b40-e04c-4b3a-9f11-aaaaaaaaaaa1", seat_id: "7bc32b40-e04c-4b3a-9f11-000000000001", qr_token: "tkt_demo_token_one_0123456789", scanned_at: null },
    { ticket_id: "dd03e7f6-11ae-4c22-8a90-aaaaaaaaaaa2", seat_id: "dd03e7f6-11ae-4c22-8a90-000000000002", qr_token: "tkt_demo_token_two_0123456789", scanned_at: null },
    { ticket_id: "e46cec24-7da0-4d55-9b31-aaaaaaaaaaa3", seat_id: "e46cec24-7da0-4d55-9b31-000000000003", qr_token: "tkt_demo_token_three_012345678", scanned_at: null },
    { ticket_id: "a1b2c3d4-0000-4000-8000-aaaaaaaaaaa4", seat_id: "a1b2c3d4-0000-4000-8000-000000000004", qr_token: "tkt_demo_token_four_012345678", scanned_at: null },
    { ticket_id: "b2c3d4e5-0000-4000-8000-aaaaaaaaaaa5", seat_id: "b2c3d4e5-0000-4000-8000-000000000005", qr_token: "tkt_demo_token_five_012345678", scanned_at: null },
    { ticket_id: "c3d4e5f6-0000-4000-8000-aaaaaaaaaaa6", seat_id: "c3d4e5f6-0000-4000-8000-000000000006", qr_token: "tkt_demo_token_six_0123456789", scanned_at: null },
  ],
} satisfies OrderDetail

export default function PrintPreviewPage() {
  return <PrintableTicket order={order} event={event} />
}
