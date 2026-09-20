import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Pool } from 'pg';

/**
 * Stands in for catalog's `GET /events/:id` so reservation can learn an event's
 * allocation mode. Only the *endpoint* is substituted: reservation's real policy
 * loader, its real HTTP call and its real dispatch logic all run.
 */
export interface FakeCatalog {
  url: string;
  setEvent: (
    eventId: string,
    policy: { allocationMode: 'whole' | 'segmented'; waitingRoomEnabled?: boolean; status?: string },
  ) => void;
  stop: () => Promise<void>;
}

export async function startFakeCatalog(): Promise<FakeCatalog> {
  const events = new Map<string, { allocation_mode: string; waiting_room_enabled: boolean; status?: string }>();

  const server: Server = createServer((req, res) => {
    const match = /^\/events\/([0-9a-f-]{36})/.exec(req.url ?? '');
    if (match === null) {
      res.writeHead(404).end();
      return;
    }
    const event = events.get(match[1]!);
    if (event === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ event_id: match[1], ...event }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake catalog did not bind');

  return {
    url: `http://127.0.0.1:${address.port}`,
    setEvent: (eventId, policy) =>
      void events.set(eventId, {
        allocation_mode: policy.allocationMode,
        waiting_room_enabled: policy.waitingRoomEnabled ?? false,
        ...(policy.status === undefined ? {} : { status: policy.status }),
      }),
    stop: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

export interface SegmentedEvent {
  eventId: string;
  tierId: string;
  seatIds: string[];
}

/**
 * Seats for a segmented event. In segmented mode the `seats` row is pure identity
 * — coach, berth, tier — and carries no status: all state lives in
 * `seat_occupancies`. `section` is the coach and `seat_number` the berth.
 */
export async function seedSegmentedSeats(pool: Pool, count: number): Promise<SegmentedEvent> {
  const eventId = randomUUID();
  const tierId = randomUUID();

  const result = await pool.query<{ seat_id: string }>(
    `INSERT INTO seats (event_id, section, row_label, seat_number, tier_id)
     SELECT $1, 'S1', 'B', g::text, $2 FROM generate_series(1, $3) AS g
     RETURNING seat_id`,
    [eventId, tierId, count],
  );

  return { eventId, tierId, seatIds: result.rows.map((r) => r.seat_id).sort() };
}

/** Force a segmented hold past expiry without sleeping (PRD §19). */
export async function expireOccupancies(pool: Pool, holdId: string): Promise<void> {
  await pool.query(`UPDATE holds SET expires_at = now() - interval '1 second' WHERE hold_id = $1`, [holdId]);
  await pool.query(
    `UPDATE seat_occupancies SET held_until = now() - interval '1 second' WHERE hold_id = $1`,
    [holdId],
  );
}
