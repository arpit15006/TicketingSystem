import { NextResponse } from "next/server"

/**
 * One-click sign-in for the seeded demo accounts.
 *
 * The exchange happens here rather than in the browser so that no demo
 * passphrase is ever shipped in the client bundle. The page asks for a *role*;
 * this route holds the credentials, performs the ordinary login against the
 * gateway, and hands back exactly the token pair `POST /identity/auth/login`
 * returns. There is no privileged path here that a normal sign-in does not
 * already have — the same email and password typed into the form would do the
 * same thing.
 */

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3000"

/** The passphrase `pnpm seed` gives every demo account except the bootstrap admin. */
const DEMO_PASSWORD = "demo passphrase 12345"

/** A deployment that wants no demo doors at all sets DEMO_LOGINS=0. */
const ENABLED = process.env.DEMO_LOGINS !== "0"

/**
 * The bootstrap admin is a real platform_admin: it can grant roles and read
 * across every organizer. So this door is opt-in, and opening it means handing
 * *this app* the credential explicitly.
 *
 * It deliberately does not read BOOTSTRAP_ADMIN_* — those belong to the seed
 * script and the identity service, which run in a different process with a
 * different env file. Inferring "this is still the throwaway account" from a
 * variable this process cannot see would have been a check that always passed,
 * which is worse than no check: it reads like a guarantee and is not one.
 *
 * `pnpm seed`'s defaults ship in .env.example. A real deployment leaves both
 * unset and the admin row simply is not there.
 */
const ADMIN_EMAIL = process.env.DEMO_ADMIN_EMAIL ?? ""
const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? ""
const adminOffered = ADMIN_EMAIL !== "" && ADMIN_PASSWORD !== ""

interface DemoAccount {
  /** Stable key the client posts back. */
  readonly role: string
  readonly label: string
  /** What this role can actually do, so the choice means something. */
  readonly blurb: string
  readonly email: string
  readonly password: string
  /** Where this role's work starts — signing in as a scanner should land on the gate. */
  readonly landing: string
}

const ACCOUNTS: readonly DemoAccount[] = [
  {
    role: "attendee",
    label: "Attendee",
    blurb: "Browse events, hold seats, pay.",
    email: "attendee@demo.test",
    password: DEMO_PASSWORD,
    landing: "/",
  },
  {
    role: "organizer",
    label: "Organizer",
    blurb: "Create events, watch seats sell.",
    email: "organizer2@demo.test",
    password: DEMO_PASSWORD,
    landing: "/organizer",
  },
  {
    role: "scanner",
    label: "Gate scanner",
    blurb: "Scan tickets at the door.",
    email: "scanner@demo.test",
    password: DEMO_PASSWORD,
    landing: "/scan",
  },
  {
    role: "platform_admin",
    label: "Platform admin",
    blurb: "Grant roles, see every organizer.",
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    landing: "/organizer",
  },
]

function available(): DemoAccount[] {
  if (!ENABLED) return []
  return ACCOUNTS.filter((a) => a.role !== "platform_admin" || adminOffered)
}

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** What the sign-in page renders as buttons. Passwords never appear here. */
export function GET(): NextResponse {
  return NextResponse.json({
    accounts: available().map(({ role, label, blurb, email, landing }) => ({
      role,
      label,
      blurb,
      email,
      landing,
    })),
  })
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { role?: unknown }
  const account = available().find((a) => a.role === body.role)
  if (account === undefined) {
    return NextResponse.json({ error: "No such demo account" }, { status: 404 })
  }

  let response: Response
  try {
    response = await fetch(`${GATEWAY}/identity/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: account.email, password: account.password }),
    })
  } catch {
    return NextResponse.json({ error: "The identity service is not reachable" }, { status: 502 })
  }

  if (!response.ok) {
    // The overwhelmingly likely cause is an unseeded database, and "invalid
    // credentials" would send someone hunting for a typo they cannot see.
    const hint =
      response.status === 401
        ? "This demo account does not exist yet — run `pnpm seed`."
        : `Sign-in failed (HTTP ${response.status})`
    return NextResponse.json({ error: hint }, { status: response.status })
  }

  const auth = (await response.json()) as Record<string, unknown>
  return NextResponse.json({ ...auth, landing: account.landing, email: account.email })
}
