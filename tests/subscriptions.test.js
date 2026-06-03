'use strict';

const request = require('supertest');
const app = require('../src/app');
const { pool, setupDb, resetDb, teardownDb } = require('./helpers/db');

beforeAll(async () => {
  await setupDb();
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await teardownDb();
});

describe('POST /api/subscriptions', () => {
  it('creates a subscription, generates a hex secret, and returns it exactly once', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .send({ target_url: 'https://example.com/hook', description: 'orders' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      target_url: 'https://example.com/hook',
      description: 'orders',
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.created_at).toEqual(expect.any(String));

    // randomBytes(32) hex => 64 lowercase hex chars.
    expect(res.body.secret).toMatch(/^[0-9a-f]{64}$/);

    // The secret is genuinely persisted (so deliveries can be signed later)...
    const { rows } = await pool.query(
      'SELECT secret FROM subscription WHERE id = $1',
      [res.body.id]
    );
    expect(rows[0].secret).toBe(res.body.secret);
  });

  it('allows creating a subscription with no secret (generate_secret: false)', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .send({ target_url: 'https://example.com/hook', generate_secret: false });

    expect(res.status).toBe(201);
    expect(res.body.secret).toBeNull();

    const { rows } = await pool.query(
      'SELECT secret FROM subscription WHERE id = $1',
      [res.body.id]
    );
    expect(rows[0].secret).toBeNull();
  });

  it('rejects a malformed target_url with a 400 validation error', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .send({ target_url: 'not-a-url' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Validation failed');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'target_url' }),
      ])
    );

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM subscription');
    expect(rows[0].n).toBe(0);
  });

  it('rejects a non-http(s) target_url', async () => {
    const res = await request(app)
      .post('/api/subscriptions')
      .send({ target_url: 'ftp://example.com/hook' });

    expect(res.status).toBe(400);
  });

  it('rejects a missing target_url', async () => {
    const res = await request(app).post('/api/subscriptions').send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/subscriptions', () => {
  it('lists subscriptions without re-exposing the secret', async () => {
    await request(app)
      .post('/api/subscriptions')
      .send({ target_url: 'https://a.example.com/hook' });
    await request(app)
      .post('/api/subscriptions')
      .send({ target_url: 'https://b.example.com/hook', generate_secret: false });

    const res = await request(app).get('/api/subscriptions');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const sub of res.body) {
      expect(sub).not.toHaveProperty('secret');
      expect(sub).toHaveProperty('has_secret');
    }
    // The one with a generated secret reports has_secret true; the opted-out
    // one reports false.
    const byUrl = Object.fromEntries(res.body.map((s) => [s.target_url, s]));
    expect(byUrl['https://a.example.com/hook'].has_secret).toBe(true);
    expect(byUrl['https://b.example.com/hook'].has_secret).toBe(false);
  });

  it('returns an empty array when there are no subscriptions', async () => {
    const res = await request(app).get('/api/subscriptions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('DELETE /api/subscriptions/:id', () => {
  it('deletes an existing subscription', async () => {
    const created = await request(app)
      .post('/api/subscriptions')
      .send({ target_url: 'https://example.com/hook' });

    const del = await request(app).delete(
      `/api/subscriptions/${created.body.id}`
    );
    expect(del.status).toBe(204);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM subscription');
    expect(rows[0].n).toBe(0);
  });

  it('returns 404 when deleting a subscription that does not exist', async () => {
    const res = await request(app).delete(
      '/api/subscriptions/00000000-0000-0000-0000-000000000000'
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-uuid id', async () => {
    const res = await request(app).delete('/api/subscriptions/not-a-uuid');
    expect(res.status).toBe(400);
  });
});
