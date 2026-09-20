import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inject } from 'vitest';
import { createTestDatabase, migrateDown, migrateUp, type TestDatabase } from '@ticketing/testkit';
import { MIGRATIONS_DIR } from '../helpers.js';

/** The schema is part of the correctness argument, so it gets asserted directly. */
describe('migrations', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ adminUrl: inject('pgAdminUrl'), migrationsDir: MIGRATIONS_DIR });
  }, 180_000);
  afterAll(async () => {
    await db.drop();
  });

  it('creates every table the reservation service owns', async () => {
    const tables = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = tables.rows.map((r) => r.table_name);
    expect(names).toContain('seats');
    expect(names).toContain('holds');
    expect(names).toContain('idempotency_keys');
    expect(names).toContain('outbox');
  });

  it('creates the indexes the allocation path depends on', async () => {
    const indexes = await db.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = indexes.rows.map((r) => r.indexname);
    expect(names).toContain('seats_one_order_per_sold_seat');
    expect(names).toContain('seats_availability');
    expect(names).toContain('outbox_unpublished');
  });

  it('defines seat_status with exactly the four states', async () => {
    const values = await db.pool.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'seat_status' ORDER BY e.enumsortorder`,
    );
    expect(values.rows.map((r) => r.enumlabel)).toEqual(['available', 'held', 'sold', 'blocked']);
  });

  it('enforces one seat per (event, section, row, number)', async () => {
    const eventId = '11111111-1111-1111-1111-111111111111';
    const tierId = '22222222-2222-2222-2222-222222222222';
    const insert = `INSERT INTO seats (event_id, section, row_label, seat_number, tier_id) VALUES ($1,'A','1','1',$2)`;
    await db.pool.query(insert, [eventId, tierId]);
    await expect(db.pool.query(insert, [eventId, tierId])).rejects.toMatchObject({ code: '23505' });
  });

  it('is reversible: down then up leaves the same schema', async () => {
    await migrateDown(db.url, MIGRATIONS_DIR, 1);

    const afterDown = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(afterDown.rows.map((r) => r.table_name)).not.toContain('seats');

    await migrateUp(db.url, MIGRATIONS_DIR);

    const afterUp = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(afterUp.rows.map((r) => r.table_name)).toContain('seats');
  });
});
