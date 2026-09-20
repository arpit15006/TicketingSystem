/**
 * PRD §17 — `pnpm seed`: a demo organizer, a venue, and an on-sale event with
 * 5,000 seats.
 *
 * Everything goes through the gateway's public API rather than writing to any
 * database directly. That is deliberate: a seed script with database credentials
 * for three services is the first crack in database-per-service (ADR-004), and it
 * would also quietly bypass the authorization rules it is supposed to demonstrate.
 *
 * Re-running is safe: registration falls back to login, and seat provisioning is
 * ON CONFLICT DO NOTHING.
 */

const GATEWAY = process.env['GATEWAY_URL'] ?? 'http://localhost:3000';
const EVENT_TITLE = 'Demo On-Sale Event';
const ADMIN_EMAIL = process.env['BOOTSTRAP_ADMIN_EMAIL'] ?? 'organizer@demo.test';
const ADMIN_PASSWORD = process.env['BOOTSTRAP_ADMIN_PASSWORD'] ?? 'demo organizer passphrase';

// 2 sections x 50 rows x 50 seats = 5,000 seats.
const SECTIONS = [
  { name: 'LOWER', rowCount: 50, seatsPerRow: 50, tier: 'Gold' },
  { name: 'UPPER', rowCount: 50, seatsPerRow: 50, tier: 'Silver' },
];

interface Result { status: number; body: any }

async function call(method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<Result> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;

  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

function expect(result: Result, ok: number[], what: string): any {
  if (!ok.includes(result.status)) {
    throw new Error(`${what} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function main(): Promise<void> {
  console.log(`seeding via ${GATEWAY}`);

  // 1. The demo organizer. BOOTSTRAP_ADMIN_EMAIL makes them a platform admin.
  let token: string;
  const registered = await call('POST', '/identity/auth/register', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, fullName: 'Demo Organizer' },
  });

  if (registered.status === 201) {
    token = registered.body.accessToken;
    console.log(`  organizer registered: ${ADMIN_EMAIL}`);
  } else if (registered.status === 409) {
    const login = expect(
      await call('POST', '/identity/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }),
      [200],
      'login',
    );
    token = login.accessToken;
    console.log(`  organizer already existed; logged in`);
  } else {
    throw new Error(`register failed: HTTP ${registered.status} ${JSON.stringify(registered.body)}`);
  }

  // 2. Reuse the demo event if it is already there.
  //
  // Without this the seed is only idempotent in its *user*: a second run would
  // create another venue, another event and another 5,000 seats. A target that
  // people re-run after every `docker compose up` has to be safe to re-run.
  const existingEvents = expect(await call('GET', '/catalog/events?limit=200'), [200], 'list events');
  const existing = (existingEvents.events as { event_id: string; title: string }[]).find(
    (candidate) => candidate.title === EVENT_TITLE,
  );

  let eventId: string;
  const tiers: Record<string, string> = {};

  if (existing !== undefined) {
    eventId = existing.event_id;
    const detail = expect(await call('GET', `/catalog/events/${eventId}`), [200], 'load event');
    for (const tier of detail.tiers as { tier_id: string; name: string }[]) tiers[tier.name] = tier.tier_id;
    console.log(`  reusing existing event: ${eventId}`);
  } else {
    const venue = expect(
      await call('POST', '/catalog/venues', {
        token,
        body: { name: 'Demo Arena', address: '1 Marine Drive', city: 'Mumbai' },
      }),
      [201],
      'create venue',
    );
    console.log(`  venue: ${venue.venue_id}`);

    const event = expect(
      await call('POST', '/catalog/events', {
        token,
        body: {
          venueId: venue.venue_id,
          title: EVENT_TITLE,
          description: 'A 5,000 seat event for load and chaos testing.',
          startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          onsaleAt: new Date().toISOString(),
          waitingRoomEnabled: false,
        },
      }),
      [201],
      'create event',
    );
    eventId = event.event_id;
    console.log(`  event: ${eventId}`);

    // Tiers and seatmap geometry. Catalog owns geometry and never seat state.
    for (const [name, pricePaise] of [['Gold', 500_000], ['Silver', 250_000]] as const) {
      const tier = expect(
        await call('POST', `/catalog/events/${eventId}/tiers`, { token, body: { name, pricePaise } }),
        [201],
        `create tier ${name}`,
      );
      tiers[name] = tier.tier_id;
    }

    for (const section of SECTIONS) {
      expect(
        await call('POST', `/catalog/events/${eventId}/sections`, {
          token,
          body: {
            tierId: tiers[section.tier],
            name: section.name,
            rowCount: section.rowCount,
            seatsPerRow: section.seatsPerRow,
          },
        }),
        [201],
        `create section ${section.name}`,
      );
    }

    expect(await call('POST', `/catalog/events/${eventId}/publish`, { token, body: { onsale: true } }), [200], 'publish');
  }

  // 6. Seat inventory — reservation is the only service that may create seats
  const seats = expect(
    await call('POST', `/inventory/${eventId}/seats`, {
      token,
      body: {
        sections: SECTIONS.map((section) => ({
          name: section.name,
          tierId: tiers[section.tier],
          rowCount: section.rowCount,
          seatsPerRow: section.seatsPerRow,
        })),
      },
    }),
    [201],
    'provision seats',
  );

  console.log(`  seats provisioned: ${seats.created} (total now ${seats.totalSeats})`);

  if (seats.totalSeats !== 5000) {
    throw new Error(`expected 5000 seats, got ${seats.totalSeats}`);
  }

  console.log('\nseed complete');
  console.log(`  event id  : ${eventId}`);
  console.log(`  organizer : ${ADMIN_EMAIL}`);
  console.log(`  seats     : ${seats.totalSeats}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
