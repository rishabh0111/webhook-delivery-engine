'use strict';

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const { clearCache } = require('../src/metrics');
const { pool, setupDb, resetDb, teardownDb } = require('./helpers/db');
const { resetQueue, closeQueue } = require('./helpers/queue');

// Seed `count` events of a given status against a throwaway subscription.
async function seedEvents(status, count) {
  const sub = await pool.query(
    "INSERT INTO subscription (target_url) VALUES ('https://example.com/hook') RETURNING id"
  );
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO event (subscription_id, idempotency_key, raw_body, status)
       VALUES ($1, $2, $3, $4)`,
      [sub.rows[0].id, `m-${status}-${i}-${Date.now()}-${Math.random()}`, Buffer.from('{}'), status]
    );
  }
}

beforeAll(async () => {
  await setupDb();
});

beforeEach(async () => {
  await resetDb();
  await resetQueue();
  clearCache();
  config.metricsCacheTtlMs = 10 * 1000; // restore default; a test mutates it
});

afterAll(async () => {
  await closeQueue();
  await teardownDb();
});

describe('GET /metrics', () => {
  it('returns queue depth (Redis) and event counts by status (Postgres) in a stable shape', async () => {
    await seedEvents('pending', 2);
    await seedEvents('delivered', 3);
    await seedEvents('dead', 1);

    const res = await request(app).get('/metrics').expect(200);

    // Queue block: every count present and numeric, with a derived depth.
    expect(res.body.queue).toEqual(
      expect.objectContaining({
        waiting: expect.any(Number),
        active: expect.any(Number),
        delayed: expect.any(Number),
        failed: expect.any(Number),
        depth: expect.any(Number),
      })
    );

    // Events block: all statuses present (defaulting to 0) plus a total.
    expect(res.body.events).toEqual({
      pending: 2,
      delivering: 0,
      delivered: 3,
      failed: 0,
      dead: 1,
      total: 6,
    });

    expect(res.body.cached).toBe(false);
    expect(typeof res.body.generated_at).toBe('string');
  });

  it('serves a cached snapshot within the TTL, then refreshes once it expires', async () => {
    await seedEvents('pending', 1);

    const first = await request(app).get('/metrics').expect(200);
    expect(first.body.events.total).toBe(1);
    expect(first.body.cached).toBe(false);

    // Mutate the DB, then read again within the TTL: the cached snapshot must
    // still report the old total (proving Postgres was not re-queried).
    await seedEvents('pending', 5);
    const cached = await request(app).get('/metrics').expect(200);
    expect(cached.body.cached).toBe(true);
    expect(cached.body.events.total).toBe(1);

    // Disable caching to force a recompute; now the new rows are visible.
    config.metricsCacheTtlMs = 0;
    const fresh = await request(app).get('/metrics').expect(200);
    expect(fresh.body.cached).toBe(false);
    expect(fresh.body.events.total).toBe(6);
  });
});
