'use strict';

const request = require('supertest');
const app = require('../src/app');
const { computeSignature } = require('../src/signing');
const store = require('../src/demo-store');
const { closeQueue } = require('./helpers/queue');

// The in-process demo receiver is a pure HTTP surface (no database), so these
// drive it directly with Supertest and assert the recorded receiver log.

beforeEach(() => {
  store.reset(true); // clear secrets, flaky counters, and the log between tests
});

afterAll(async () => {
  await closeQueue();
});

describe('demo receiver — outcome codes', () => {
  it('returns the fixed status for ok / reject / down', async () => {
    expect((await request(app).post('/demo/receiver/ok').send('{}')).status).toBe(200);
    expect((await request(app).post('/demo/receiver/reject').send('{}')).status).toBe(401);
    expect((await request(app).post('/demo/receiver/down').send('{}')).status).toBe(503);
  });
});

describe('demo receiver — flaky', () => {
  it('fails the first N attempts per webhook id, then succeeds, counting per id', async () => {
    const post = (id) =>
      request(app).post('/demo/receiver/flaky/2').set('x-webhook-id', id).send('{}');

    expect((await post('evt-a')).status).toBe(503); // attempt 1
    expect((await post('evt-a')).status).toBe(503); // attempt 2
    expect((await post('evt-a')).status).toBe(200); // attempt 3 -> recovers

    // A different webhook id has its own independent counter.
    expect((await post('evt-b')).status).toBe(503);
  });
});

describe('demo receiver — signature verification + log', () => {
  it('records a valid signature when it matches a registered demo secret', async () => {
    const secret = 'a'.repeat(64);
    store.registerSecret(secret);
    const body = JSON.stringify({ hello: 'world' });
    const timestamp = '1700000000';

    await request(app)
      .post('/demo/receiver/ok')
      .set('x-webhook-id', 'evt-1')
      .set('x-webhook-timestamp', timestamp)
      .set('x-webhook-signature', 'sha256=' + computeSignature(secret, timestamp, Buffer.from(body)))
      .set('Content-Type', 'application/json')
      .send(body);

    const log = (await request(app).get('/demo/receiver/log')).body;
    expect(log[0]).toMatchObject({ webhook_id: 'evt-1', status_returned: 200, signature_valid: true });
  });

  it('records signature_valid=false for a bad signature and null when unsigned', async () => {
    store.registerSecret('b'.repeat(64));

    await request(app)
      .post('/demo/receiver/ok')
      .set('x-webhook-id', 'bad')
      .set('x-webhook-timestamp', '1700000000')
      .set('x-webhook-signature', 'sha256=deadbeef')
      .send('{}');

    await request(app).post('/demo/receiver/ok').set('x-webhook-id', 'unsigned').send('{}');

    const log = (await request(app).get('/demo/receiver/log')).body;
    const byId = Object.fromEntries(log.map((e) => [e.webhook_id, e]));
    expect(byId.bad.signature_valid).toBe(false);
    expect(byId.unsigned.signature_valid).toBe(null);
  });
});
