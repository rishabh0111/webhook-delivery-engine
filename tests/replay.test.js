'use strict';

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const { processDelivery } = require('../src/worker');
const { queue } = require('../src/queue');
const { pool, setupDb, resetDb, teardownDb } = require('./helpers/db');
const { resetQueue, closeQueue } = require('./helpers/queue');

// Fake receiver the delivery worker genuinely POSTs to.
let server;
let baseUrl;
let nextStatus;

beforeAll(async () => {
  await setupDb();
  server = http.createServer((req, res) => {
    req.resume(); // drain body
    req.on('end', () => {
      res.statusCode = nextStatus;
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await resetDb();
  await resetQueue();
  nextStatus = 200;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeQueue();
  await teardownDb();
});

// Seed a dead event plus its dead_letter row, optionally with prior attempts.
async function seedDeadEvent({ priorAttempts = 0 } = {}) {
  const sub = await pool.query(
    'INSERT INTO subscription (target_url) VALUES ($1) RETURNING id',
    [baseUrl]
  );
  const event = await pool.query(
    `INSERT INTO event (subscription_id, idempotency_key, raw_body, status)
     VALUES ($1, $2, $3, 'dead') RETURNING id`,
    [sub.rows[0].id, `rp-${crypto.randomUUID()}`, Buffer.from('{"replay":true}', 'utf8')]
  );
  const eventId = event.rows[0].id;

  for (let i = 1; i <= priorAttempts; i++) {
    await pool.query(
      `INSERT INTO delivery_attempt (event_id, attempt_number, status_code, duration_ms, error)
       VALUES ($1, $2, 500, 100, 'prior failure')`,
      [eventId, i]
    );
  }

  const dl = await pool.query(
    `INSERT INTO dead_letter (event_id, reason) VALUES ($1, 'exhausted retries') RETURNING id`,
    [eventId]
  );
  return { eventId, deadLetterId: dl.rows[0].id };
}

describe('POST /api/dead-letters/:id/replay', () => {
  it('flips a dead event to pending, re-enqueues it, stamps replayed_at, and delivers', async () => {
    const { eventId, deadLetterId } = await seedDeadEvent();

    const res = await request(app)
      .post(`/api/dead-letters/${deadLetterId}/replay`)
      .expect(200);

    expect(res.body.event_id).toBe(eventId);
    expect(res.body.status).toBe('pending');

    // Job is in the queue.
    expect(await queue.getJob(eventId)).toBeDefined();

    // dead_letter.replayed_at is stamped.
    const dl = await pool.query(
      'SELECT replayed_at FROM dead_letter WHERE id = $1',
      [deadLetterId]
    );
    expect(dl.rows[0].replayed_at).not.toBeNull();

    // Run the queued delivery so we verify the full round-trip.
    await processDelivery({ data: { eventId, correlationId: 'replay-test' } });

    const ev = await pool.query('SELECT status FROM event WHERE id = $1', [eventId]);
    expect(ev.rows[0].status).toBe('delivered');

    const attempts = await pool.query(
      'SELECT attempt_number FROM delivery_attempt WHERE event_id = $1',
      [eventId]
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0].attempt_number).toBe(1);
  });

  it('returns 409 on a second replay when the event is no longer dead (double-replay guard)', async () => {
    const { deadLetterId } = await seedDeadEvent();

    // First replay flips dead->pending.
    await request(app)
      .post(`/api/dead-letters/${deadLetterId}/replay`)
      .expect(200);

    // Event is now pending (not dead) — a second replay must be rejected.
    await request(app)
      .post(`/api/dead-letters/${deadLetterId}/replay`)
      .expect(409);
  });

  it('preserves prior delivery_attempt rows; replay appends a new attempt with a monotonic number', async () => {
    const { eventId, deadLetterId } = await seedDeadEvent({ priorAttempts: 3 });

    await request(app)
      .post(`/api/dead-letters/${deadLetterId}/replay`)
      .expect(200);

    await processDelivery({ data: { eventId } });

    const attempts = await pool.query(
      'SELECT attempt_number FROM delivery_attempt WHERE event_id = $1 ORDER BY attempt_number',
      [eventId]
    );
    // 3 prior + 1 new
    expect(attempts.rows).toHaveLength(4);
    expect(attempts.rows.map((r) => r.attempt_number)).toEqual([1, 2, 3, 4]);
  });

  it('returns 404 for an unknown dead_letter id', async () => {
    await request(app)
      .post(`/api/dead-letters/${crypto.randomUUID()}/replay`)
      .expect(404);
  });

  it('returns 400 for a non-UUID id', async () => {
    await request(app)
      .post('/api/dead-letters/not-a-uuid/replay')
      .expect(400);
  });
});
