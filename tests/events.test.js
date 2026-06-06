'use strict';

const request = require('supertest');
const app = require('../src/app');
const { pool, setupDb, resetDb, teardownDb } = require('./helpers/db');
const { queue, resetQueue, closeQueue } = require('./helpers/queue');

async function createSubscription() {
  const { rows } = await pool.query(
    "INSERT INTO subscription (target_url) VALUES ('https://example.com/hook') RETURNING id"
  );
  return rows[0].id;
}

beforeAll(async () => {
  await setupDb();
});

beforeEach(async () => {
  await resetDb();
  await resetQueue();
});

afterAll(async () => {
  await closeQueue();
  await teardownDb();
});

describe('POST /api/events', () => {
  it('persists a new event as pending, returns 202, and enqueues a job keyed by event id', async () => {
    const subId = await createSubscription();
    const payload = JSON.stringify({ order_id: 42 });

    const res = await request(app)
      .post('/api/events')
      .set('X-Subscription-Id', subId)
      .set('Idempotency-Key', 'key-1')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      subscription_id: subId,
      idempotency_key: 'key-1',
      status: 'pending',
    });

    // Exact bytes persisted verbatim.
    const { rows } = await pool.query(
      'SELECT raw_body FROM event WHERE id = $1',
      [res.body.id]
    );
    expect(rows[0].raw_body.toString('utf8')).toBe(payload);

    // A job is enqueued with jobId === event id.
    const job = await queue.getJob(res.body.id);
    expect(job).toBeDefined();
    expect(job.data.eventId).toBe(res.body.id);
  });

  it('returns 200 with the original event and enqueues no new job on idempotency-key conflict', async () => {
    const subId = await createSubscription();

    const first = await request(app)
      .post('/api/events')
      .set('X-Subscription-Id', subId)
      .set('Idempotency-Key', 'dup-key')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ n: 1 }));
    expect(first.status).toBe(202);

    const second = await request(app)
      .post('/api/events')
      .set('X-Subscription-Id', subId)
      .set('Idempotency-Key', 'dup-key')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ n: 2 }));

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);

    // Still exactly one event and one job.
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM event');
    expect(rows[0].n).toBe(1);
    const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
    expect(counts.waiting + counts.delayed + counts.active).toBe(1);
  });

  it('auto-generates an idempotency_key when the header is omitted', async () => {
    const subId = await createSubscription();

    const res = await request(app)
      .post('/api/events')
      .set('X-Subscription-Id', subId)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 1 }));

    expect(res.status).toBe(202);
    expect(res.body.idempotency_key).toEqual(expect.any(String));
    expect(res.body.idempotency_key.length).toBeGreaterThan(0);
  });

  it('returns 400 when X-Subscription-Id is missing or not a UUID', async () => {
    const missing = await request(app)
      .post('/api/events')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 1 }));
    expect(missing.status).toBe(400);

    const subId = await createSubscription();
    const bad = await request(app)
      .post('/api/events')
      .set('X-Subscription-Id', 'not-a-uuid')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 1 }));
    expect(bad.status).toBe(400);
    // sanity: the valid subscription still has no events
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM event');
    expect(rows[0].n).toBe(0);
    expect(subId).toEqual(expect.any(String));
  });

  it('returns 404 when the subscription does not exist', async () => {
    const res = await request(app)
      .post('/api/events')
      .set('X-Subscription-Id', '00000000-0000-0000-0000-000000000000')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ a: 1 }));
    expect(res.status).toBe(404);
  });

  it('returns 400 when the body is empty', async () => {
    const subId = await createSubscription();
    const res = await request(app)
      .post('/api/events')
      .set('X-Subscription-Id', subId);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/events/:id', () => {
  it('returns the event with its current status and an (empty) attempt timeline', async () => {
    const subId = await createSubscription();
    const created = await request(app)
      .post('/api/events')
      .set('X-Subscription-Id', subId)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ hello: 'world' }));

    const res = await request(app).get(`/api/events/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.status).toBe('pending');
    expect(res.body.attempts).toEqual([]);
  });

  it('returns 404 for an unknown event id', async () => {
    const res = await request(app).get(
      '/api/events/00000000-0000-0000-0000-000000000000'
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-uuid id', async () => {
    const res = await request(app).get('/api/events/nope');
    expect(res.status).toBe(400);
  });
});
