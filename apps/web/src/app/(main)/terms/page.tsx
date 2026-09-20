import type { Metadata } from "next"

export const metadata: Metadata = { title: "Terms" }

export default function TermsPage() {
  return (
    <article className="prose prose-neutral mx-auto max-w-2xl dark:prose-invert">
      <h1>Terms of use</h1>
      <p className="lead">
        This is a demonstration ticketing platform. Payments run in Razorpay test mode and no real money is
        charged. The events, venues and prices are illustrative.
      </p>
      <h2>Holds</h2>
      <p>
        A hold reserves seats for a fixed window shown on the seat page. When it expires the seats return to
        sale automatically. A hold is not a purchase.
      </p>
      <h2>Payment and confirmation</h2>
      <p>
        Payment is authorized at checkout and captured only after the seats are confirmed. If confirmation
        fails because the hold has expired, the authorization is released and no charge is made.
      </p>
      <h2>Tickets</h2>
      <p>
        Each ticket is a QR code that admits once. Sharing a code shares the admission; the first scan wins.
      </p>
      <h2>Accounts</h2>
      <p>
        You are responsible for the credentials on your account. Signing out revokes your session on this
        device and every other one.
      </p>
    </article>
  )
}
