import QRCode from "react-qr-code"
import { CATEGORY_LABEL, categoryOf, monogram, posterGradient } from "@/lib/poster"
import { formatEventDate, formatPaise } from "@/lib/format"
import type { EventDetail, OrderDetail } from "@/lib/api-types"
import { cn } from "cn"

/**
 * The paper ticket.
 *
 * The screen page prints badly by definition: its hero is a CSS gradient the
 * print pipeline drops, so the title came out grey on white and unreadable, with
 * the stepper and the page chrome along for the ride. Rather than bend the screen
 * layout into paper with `print:` variants, this is a separate sheet — hidden on
 * screen, the only thing visible in print — laid out for A4 in ink that is
 * explicitly opted into colour. Its styles live in `globals.css` under
 * `@media print`, in literal colours: the theme tokens follow dark mode, and a
 * ticket printed at 1am should not arrive as white ink on a black rectangle.
 *
 * Every stub carries the event, the venue, the seat and its own ticket id, because
 * a stub is made to be torn off and handed over, and paper has no network to fall
 * back on.
 */
export function PrintableTicket({ order, event }: { order: OrderDetail; event: EventDetail }) {
  const count = order.tickets.length

  return (
    <section className="tk-sheet" aria-hidden>
      <header className={cn("tk-hero", posterGradient(event.event_id, event.title))}>
        <span className="tk-hero-mono">{monogram(event.title)}</span>
        <div className="tk-hero-top">
          <span className="tk-brand">Ticketing</span>
          <span className="tk-chip">{CATEGORY_LABEL[categoryOf(event.title)]}</span>
        </div>
        <h1 className="tk-title">{event.title}</h1>
        <p className="tk-meta">
          <span>{formatEventDate(event.starts_at)}</span>
          <span className="tk-dot" />
          <span>
            {event.venue_name}, {event.venue_city}
          </span>
        </p>
      </header>

      <dl className="tk-strip">
        <div>
          <dt>Admits</dt>
          <dd>
            {count} {count === 1 ? "person" : "people"}
          </dd>
        </div>
        <div>
          <dt>Total paid</dt>
          <dd>{formatPaise(order.amountPaise)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>Confirmed</dd>
        </div>
        <div>
          <dt>Order</dt>
          <dd className="tk-mono">{order.orderId.slice(0, 8).toUpperCase()}</dd>
        </div>
      </dl>

      <div className="tk-body">
        <h2 className="tk-h2">
          <span>Your tickets</span>
          <span className="tk-h2-note">One code per seat · each admits exactly once</span>
        </h2>

        <ul className="tk-stubs">
          {order.tickets.map((ticket, index) => (
            <li key={ticket.ticket_id} className="tk-stub">
              <div className="tk-stub-card">
                <div className="tk-rail">
                  <span>Admit one</span>
                </div>

                <div className="tk-stub-main">
                  <p className="tk-stub-n">
                    Ticket {index + 1} <span>of {count}</span>
                  </p>
                  <p className="tk-stub-title">{event.title}</p>
                  <dl className="tk-stub-grid">
                    <div>
                      <dt>Doors</dt>
                      <dd>{formatEventDate(event.starts_at)}</dd>
                    </div>
                    <div>
                      <dt>Venue</dt>
                      <dd>
                        {event.venue_name}, {event.venue_city}
                      </dd>
                    </div>
                    <div>
                      <dt>Seat</dt>
                      <dd className="tk-mono">{ticket.seat_id.slice(0, 8).toUpperCase()}</dd>
                    </div>
                    <div>
                      <dt>Ticket</dt>
                      <dd className="tk-mono">{ticket.ticket_id.slice(0, 8).toUpperCase()}</dd>
                    </div>
                  </dl>
                </div>

                <div className="tk-perf" />

                <div className="tk-qr">
                  <QRCode value={ticket.qr_token} size={128} />
                  <p>Scan at the gate</p>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <footer className="tk-foot">
          <p>
            Each code is scanned once and then dead. Screenshots and photocopies of the same code do
            not admit a second person — bring one code per person in your party.
          </p>
          <p className="tk-mono">Order {order.orderId}</p>
        </footer>
      </div>
    </section>
  )
}
