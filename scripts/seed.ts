/**
 * PRD §17 — `pnpm seed`: a working demo, every role included.
 *
 * Everything goes through the gateway's public API rather than writing to any
 * database directly. That is deliberate: a seed script holding database
 * credentials for three services is the first crack in database-per-service
 * (ADR-004), and it would quietly bypass the authorization rules it exists to
 * demonstrate. In particular the second organizer below is a *plain* organizer,
 * not an admin: if the grant chain (catalog → identity) ever breaks, this seed
 * breaks with it.
 *
 * Re-running is safe: users fall back to login, events are looked up by title,
 * grants are ON CONFLICT DO NOTHING, and seat provisioning is idempotent.
 */

const GATEWAY = process.env['GATEWAY_URL'] ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env['BOOTSTRAP_ADMIN_EMAIL'] ?? 'organizer@demo.test';
const ADMIN_PASSWORD = process.env['BOOTSTRAP_ADMIN_PASSWORD'] ?? 'demo organizer passphrase';
const DEMO_PASSWORD = 'demo passphrase 12345';

const day = 86_400_000;
const at = (daysFromNow: number, hour = 19): string => {
  const d = new Date(Date.now() + daysFromNow * day);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

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

/* ───────────────────────────────── users ────────────────────────────────── */

interface User { userId: string; email: string; password: string; token: string }

async function ensureUser(email: string, password: string, fullName: string): Promise<User> {
  const registered = await call('POST', '/identity/auth/register', { body: { email, password, fullName } });
  if (registered.status === 201) {
    console.log(`  user registered      ${email}`);
    return { userId: registered.body.userId, email, password, token: registered.body.accessToken };
  }
  if (registered.status !== 409) expect(registered, [201], `register ${email}`);
  const login = expect(await call('POST', '/identity/auth/login', { body: { email, password } }), [200], `login ${email}`);
  console.log(`  user exists          ${email}`);
  return { userId: login.userId, email, password, token: login.accessToken };
}

/** Grants are read at token issue time (PRD §9.1); a fresh login picks them up. */
async function relogin(user: User): Promise<User> {
  const login = expect(
    await call('POST', '/identity/auth/login', { body: { email: user.email, password: user.password } }),
    [200],
    `relogin ${user.email}`,
  );
  return { ...user, token: login.accessToken };
}

async function grant(admin: User, user: User, role: string, scope?: { resourceType: 'event' | 'venue'; resourceId: string }): Promise<void> {
  expect(
    await call('POST', `/identity/users/${user.userId}/roles`, { token: admin.token, body: { role, ...scope } }),
    [201],
    `grant ${role} to ${user.email}`,
  );
}

/* ───────────────────────────────── venues ───────────────────────────────── */

interface Venue { venue_id: string; name: string; city: string }

const venueCache = new Map<string, Venue>();

async function ensureVenue(by: User, name: string, address: string, city: string): Promise<Venue> {
  const cached = venueCache.get(name);
  if (cached !== undefined) return cached;

  // Venues are not listable; find one by the events that reference it.
  const events = expect(await call('GET', '/catalog/events?limit=200'), [200], 'list events').events as {
    venue_id: string; venue_name: string; venue_city: string;
  }[];
  const seen = events.find((e) => e.venue_name === name);
  if (seen !== undefined) {
    const venue = { venue_id: seen.venue_id, name, city: seen.venue_city };
    venueCache.set(name, venue);
    return venue;
  }

  const created = expect(await call('POST', '/catalog/venues', { token: by.token, body: { name, address, city } }), [201], `venue ${name}`);
  console.log(`  venue created        ${name}, ${city}`);
  const venue = { venue_id: created.venue_id, name, city };
  venueCache.set(name, venue);
  return venue;
}

/* ───────────────────────────────── events ───────────────────────────────── */

interface TierSpec { name: string; pricePaise: number }
interface SectionSpec { name: string; tier: string; rows: number; seatsPerRow: number }

interface EventSpec {
  title: string;
  description: string;
  venue: Venue;
  startsInDays: number;
  hour?: number;
  /** 'onsale' | 'published' (upcoming, not yet buyable) | 'draft' */
  status: 'onsale' | 'published' | 'draft';
  waitingRoom?: boolean;
  holdSeconds?: number;
  tiers: TierSpec[];
  sections: SectionSpec[];
}

async function ensureEvent(by: User, spec: EventSpec): Promise<{ eventId: string; seats: number }> {
  // Public listing only shows published/onsale; the organizer's own view shows all.
  const mine = expect(await call('GET', '/catalog/events/mine', { token: by.token }), [200], 'my events').events as {
    event_id: string; title: string;
  }[];
  const existing = mine.find((e) => e.title === spec.title);

  let eventId: string;
  const tierIds = new Map<string, string>();

  if (existing !== undefined) {
    eventId = existing.event_id;
    const detail = expect(await call('GET', `/catalog/events/${eventId}`), [200], 'event detail');
    for (const tier of detail.tiers as { tier_id: string; name: string }[]) tierIds.set(tier.name, tier.tier_id);
    console.log(`  event exists         ${spec.title}`);
  } else {
    const created = expect(
      await call('POST', '/catalog/events', {
        token: by.token,
        body: {
          venueId: spec.venue.venue_id,
          title: spec.title,
          description: spec.description,
          startsAt: at(spec.startsInDays, spec.hour ?? 19),
          onsaleAt: spec.status === 'onsale' ? new Date().toISOString() : at(3, 10),
          waitingRoomEnabled: spec.waitingRoom ?? false,
          holdDurationSeconds: spec.holdSeconds ?? 480,
        },
      }),
      [201],
      `create ${spec.title}`,
    );
    eventId = created.event_id;

    // Creation just granted organizer:event:<id>; the token must carry it before
    // the scoped calls below (a plain organizer has no other way in).
    by = await relogin(by);

    for (const tier of spec.tiers) {
      const t = expect(
        await call('POST', `/catalog/events/${eventId}/tiers`, { token: by.token, body: { name: tier.name, pricePaise: tier.pricePaise } }),
        [201],
        `tier ${tier.name}`,
      );
      tierIds.set(tier.name, t.tier_id);
    }
    for (const section of spec.sections) {
      expect(
        await call('POST', `/catalog/events/${eventId}/sections`, {
          token: by.token,
          body: { tierId: tierIds.get(section.tier), name: section.name, rowCount: section.rows, seatsPerRow: section.seatsPerRow },
        }),
        [201],
        `section ${section.name}`,
      );
    }
    if (spec.status !== 'draft') {
      expect(
        await call('POST', `/catalog/events/${eventId}/publish`, { token: by.token, body: { onsale: spec.status === 'onsale' } }),
        [200],
        `publish ${spec.title}`,
      );
    }
    console.log(`  event created        ${spec.title}  [${spec.status}]`);
  }

  // Seat inventory — reservation is the only service that may create seats, and
  // it authorizes by the organizer:event:<id> grant that creation just issued.
  if (spec.status === 'draft') return { eventId, seats: 0 };
  by = await relogin(by);
  const seats = expect(
    await call('POST', `/inventory/${eventId}/seats`, {
      token: by.token,
      body: {
        sections: spec.sections.map((s) => ({ name: s.name, tierId: tierIds.get(s.tier), rowCount: s.rows, seatsPerRow: s.seatsPerRow })),
      },
    }),
    [201],
    `provision ${spec.title}`,
  );
  return { eventId, seats: seats.totalSeats as number };
}

/* ────────────────────────────────── main ────────────────────────────────── */

async function main(): Promise<void> {
  console.log(`seeding via ${GATEWAY}\n`);

  console.log('users');
  let admin = await ensureUser(ADMIN_EMAIL, ADMIN_PASSWORD, 'Demo Organizer');
  let organizer = await ensureUser('organizer2@demo.test', DEMO_PASSWORD, 'Priya Nair');
  let scanner = await ensureUser('scanner@demo.test', DEMO_PASSWORD, 'Gate Scanner');
  await ensureUser('attendee@demo.test', DEMO_PASSWORD, 'Rahul Mehta');

  // A *plain* organizer, on purpose: global organizer + venue_admin roles, and
  // nothing else. Everything it does below must succeed on those alone.
  await grant(admin, organizer, 'organizer');
  await grant(admin, organizer, 'venue_admin');
  organizer = await relogin(organizer);
  admin = await relogin(admin);

  console.log('\nvenues');
  const mumbai = await ensureVenue(admin, 'Demo Arena', '1 Marine Drive', 'Mumbai');
  const delhi = await ensureVenue(admin, 'Jawaharlal Nehru Stadium', 'Lodhi Road', 'Delhi');
  const bengaluru = await ensureVenue(organizer, 'Palace Grounds', 'Jayamahal Road', 'Bengaluru');
  const wankhede = await ensureVenue(admin, 'Wankhede Stadium', 'D Road, Churchgate', 'Mumbai');
  organizer = await relogin(organizer); // venue_admin:venue:<Palace Grounds> is in the token now

  console.log('\nevents');
  const results: { title: string; eventId: string; seats: number; status: string }[] = [];
  const run = async (by: User, spec: EventSpec) => {
    const r = await ensureEvent(by, spec);
    results.push({ title: spec.title, eventId: r.eventId, seats: r.seats, status: spec.status });
    return r;
  };

  // Kept exactly as it was: the load test and the runbook depend on 5,000 seats here.
  const demo = await run(admin, {
    title: 'Demo On-Sale Event',
    description: 'A 5,000 seat event for load and chaos testing.',
    venue: mumbai, startsInDays: 30, status: 'onsale',
    tiers: [{ name: 'Gold', pricePaise: 500_000 }, { name: 'Silver', pricePaise: 250_000 }],
    sections: [{ name: 'LOWER', tier: 'Gold', rows: 50, seatsPerRow: 50 }, { name: 'UPPER', tier: 'Silver', rows: 50, seatsPerRow: 50 }],
  });
  if (demo.seats !== 5000) throw new Error(`expected 5000 seats on the demo event, got ${demo.seats}`);

  await run(admin, {
    title: 'Arijit Singh — Live in Concert',
    description: 'An evening of Arijit\'s greatest hits with a full live orchestra. Doors open 5 PM.',
    venue: mumbai, startsInDays: 12, status: 'onsale',
    tiers: [{ name: 'Platinum', pricePaise: 1_200_000 }, { name: 'Gold', pricePaise: 650_000 }, { name: 'Silver', pricePaise: 299_900 }],
    sections: [
      { name: 'FLOOR', tier: 'Platinum', rows: 8, seatsPerRow: 20 },
      { name: 'STAND A', tier: 'Gold', rows: 12, seatsPerRow: 24 },
      { name: 'STAND B', tier: 'Silver', rows: 16, seatsPerRow: 30 },
    ],
  });

  await run(admin, {
    title: 'Zakir Khan: Tathastu',
    description: 'Stand-up comedy. Sakht launda, soft heart. 90 minutes, 18+.',
    venue: delhi, startsInDays: 5, hour: 20, status: 'onsale', holdSeconds: 300,
    tiers: [{ name: 'Premium', pricePaise: 249_900 }, { name: 'Regular', pricePaise: 99_900 }],
    sections: [{ name: 'ORCHESTRA', tier: 'Premium', rows: 6, seatsPerRow: 18 }, { name: 'BALCONY', tier: 'Regular', rows: 10, seatsPerRow: 22 }],
  });

  await run(admin, {
    title: 'Mumbai Indians vs Chennai Super Kings',
    description: 'IPL 2026 — the El Clásico of Indian cricket. Waiting room in effect; demand is extreme.',
    venue: wankhede, startsInDays: 9, hour: 19, status: 'onsale', waitingRoom: true, holdSeconds: 420,
    tiers: [{ name: 'Pavilion', pricePaise: 1_500_000 }, { name: 'Grand Stand', pricePaise: 450_000 }, { name: 'North Stand', pricePaise: 150_000 }],
    sections: [
      { name: 'PAVILION', tier: 'Pavilion', rows: 5, seatsPerRow: 20 },
      { name: 'GRAND', tier: 'Grand Stand', rows: 15, seatsPerRow: 30 },
      { name: 'NORTH', tier: 'North Stand', rows: 20, seatsPerRow: 40 },
    ],
  });

  await run(admin, {
    title: 'Coldplay: Music of the Spheres',
    description: 'World tour. Tickets go on sale in three days — set a reminder.',
    venue: delhi, startsInDays: 60, status: 'published',
    tiers: [{ name: 'Golden Circle', pricePaise: 3_500_000 }, { name: 'Level 1', pricePaise: 1_250_000 }, { name: 'Level 2', pricePaise: 650_000 }],
    sections: [
      { name: 'GC', tier: 'Golden Circle', rows: 10, seatsPerRow: 30 },
      { name: 'L1', tier: 'Level 1', rows: 20, seatsPerRow: 40 },
      { name: 'L2', tier: 'Level 2', rows: 25, seatsPerRow: 40 },
    ],
  });

  // Created by the plain organizer, at the venue the plain organizer created.
  // This is the proof that the grant chain works without an admin.
  await run(organizer, {
    title: 'Sunburn Arena ft. Martin Garrix',
    description: 'Open-air EDM. Gates 4 PM, headliner 9 PM. Rain or shine.',
    venue: bengaluru, startsInDays: 21, hour: 16, status: 'onsale',
    tiers: [{ name: 'VIP', pricePaise: 800_000 }, { name: 'GA', pricePaise: 250_000 }],
    sections: [{ name: 'VIP DECK', tier: 'VIP', rows: 6, seatsPerRow: 25 }, { name: 'ARENA', tier: 'GA', rows: 20, seatsPerRow: 40 }],
  });

  await run(organizer, {
    title: 'Hamlet — NCPA Theatre Company',
    description: 'Shakespeare\'s tragedy, staged in the round. 2h 40m with one interval.',
    venue: bengaluru, startsInDays: 3, hour: 19, status: 'onsale', holdSeconds: 600,
    tiers: [{ name: 'Stalls', pricePaise: 150_000 }, { name: 'Circle', pricePaise: 80_000 }],
    sections: [{ name: 'STALLS', tier: 'Stalls', rows: 8, seatsPerRow: 16 }, { name: 'CIRCLE', tier: 'Circle', rows: 6, seatsPerRow: 20 }],
  });

  await run(organizer, {
    title: 'Prithvi Theatre: Tumhari Amrita',
    description: 'Draft — dates being finalised.',
    venue: bengaluru, startsInDays: 45, status: 'draft',
    tiers: [{ name: 'General', pricePaise: 50_000 }],
    sections: [{ name: 'HALL', tier: 'General', rows: 10, seatsPerRow: 15 }],
  });

  // The gate scanner is hired per event (PRD §9.2 — "events assigned to them").
  console.log('\nscanner grants');
  for (const r of results) {
    if (r.status === 'draft') continue;
    await grant(admin, scanner, 'scanner', { resourceType: 'event', resourceId: r.eventId });
  }
  scanner = await relogin(scanner);
  console.log(`  scanner@demo.test    → ${results.filter((r) => r.status !== 'draft').length} events`);

  console.log('\nseed complete\n');
  console.log('  accounts (all roles, password for non-admin: "demo passphrase 12345")');
  console.log(`    platform_admin      ${ADMIN_EMAIL}   (${ADMIN_PASSWORD})`);
  console.log('    organizer           organizer2@demo.test');
  console.log('    scanner             scanner@demo.test');
  console.log('    attendee            attendee@demo.test');
  console.log('\n  events');
  for (const r of results) console.log(`    ${r.status.padEnd(9)} ${String(r.seats).padStart(5)} seats  ${r.title}  ${r.eventId}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
