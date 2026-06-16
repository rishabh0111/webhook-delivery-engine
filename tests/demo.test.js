'use strict';

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config');
const demoState = require('../src/demo-state');
const store = require('../src/demo-store');
const { enqueueDelivery, queue } = require('../src/queue');
const { pool, setupDb, resetDb, teardownDb } = require('./helpers/db');
const { resetQueue, closeQueue } = require('./helpers/queue');

beforeAll(async () => {
  await setupDb();
});

beforeEach(async () => {
  await resetDb();
  await resetQueue();
  demoState.setFastMode(false);
  store.reset(true);
});

afterAll(async () => {
  await closeQueue();
  await teardownDb();
});

describe('POST /api/demo/seed', () => {
  it('creates the demo subscriptions and is idempotent on re-run', async () => {
    const first = await request(app).post('/api/demo/seed');
    expect(first.status).toBe(200);
    expect(Object.keys(first.body.subscriptions).sort()).toEqual(
      ['down', 'flaky', 'reject', 'signedOk', 'slow', 'unsignedOk']
    );

    const afterFirst = await request(app).get('/api/subscriptions');
    expect(afterFirst.body).toHaveLength(6);

    // Signed scenarios carry a secret; the unsigned one does not.
    expect(first.body.subscriptions.signedOk.signed).toBe(true);
    expect(first.body.subscriptions.unsignedOk.signed).toBe(false);

    // Re-seeding reuses rows (matched by description) rather than duplicating.
    const second = await request(app).post('/api/demo/seed');
    expect(second.body.subscriptions.signedOk.id).toBe(first.body.subscriptions.signedOk.id);
    const afterSecond = await request(app).get('/api/subscriptions');
    expect(afterSecond.body).toHaveLength(6);
  });
});

describe('POST /api/demo/reset', () => {
  it('clears events but keeps subscriptions', async () => {
    const { body } = await request(app).post('/api/demo/seed');
    await request(app)
      .post('/api/events')
      .set('X-Subscription-Id', body.subscriptions.signedOk.id)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ hello: 'world' }));

    expect((await request(app).get('/api/events')).body.length).toBeGreaterThan(0);

    const reset = await request(app).post('/api/demo/reset');
    expect(reset.status).toBe(200);
    expect((await request(app).get('/api/events')).body).toEqual([]);
    expect((await request(app).get('/api/subscriptions')).body).toHaveLength(6);
  });
});

describe('demo gating', () => {
  it('404s the demo routes when demo is disabled', async () => {
    config.demoEnabled = false;
    try {
      expect((await request(app).post('/api/demo/seed')).status).toBe(404);
      expect((await request(app).get('/api/demo/settings')).status).toBe(404);
      expect((await request(app).post('/demo/receiver/ok').send('{}')).status).toBe(404);
    } finally {
      config.demoEnabled = true;
    }
  });
});

describe('runtime backoff override', () => {
  it('enqueues jobs with the fast-mode backoff when fast mode is on, else the production base', async () => {
    demoState.setFastMode(true);
    const fast = await enqueueDelivery('11111111-1111-1111-1111-111111111111', 'test');
    expect(fast.opts.backoff.delay).toBe(2000);

    demoState.setFastMode(false);
    const slow = await enqueueDelivery('22222222-2222-2222-2222-222222222222', 'test');
    expect(slow.opts.backoff.delay).toBe(config.backoffDelayMs);

    await queue.remove('11111111-1111-1111-1111-111111111111');
    await queue.remove('22222222-2222-2222-2222-222222222222');
  });
});
