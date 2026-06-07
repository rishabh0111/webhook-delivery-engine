'use strict';

const http = require('http');
const crypto = require('crypto');
const { processDelivery } = require('../src/worker');
const { pool, setupDb, resetDb, teardownDb } = require('./helpers/db');
const { closeQueue } = require('./helpers/queue');

// A throwaway HTTP server the worker genuinely POSTs to — preferred over
// mocking fetch so the bytes-on-the-wire are exercised for real.
let server;
let baseUrl;
let received;
let nextStatus;

beforeAll(async () => {
  await setupDb();
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = { method: req.method, headers: req.headers, body: Buffer.concat(chunks) };
      res.statusCode = nextStatus;
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await resetDb();
  received = null;
  nextStatus = 200;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closeQueue();
  await teardownDb();
});

async function seedEvent(rawBody, status = 'pending', secret = null) {
  const sub = await pool.query(
    'INSERT INTO subscription (target_url, secret) VALUES ($1, $2) RETURNING id',
    [baseUrl, secret]
  );
  const event = await pool.query(
    `INSERT INTO event (subscription_id, idempotency_key, raw_body, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [sub.rows[0].id, `wk-${crypto.randomUUID()}`, rawBody, status]
  );
  return event.rows[0].id;
}

describe('processDelivery (worker seam)', () => {
  it('POSTs raw_body to the target and marks the event delivered on 2xx, recording one attempt', async () => {
    const payload = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
    const eventId = await seedEvent(payload);

    await processDelivery({ data: { eventId, correlationId: 'test' } });

    expect(received).not.toBeNull();
    expect(received.method).toBe('POST');
    expect(received.body.equals(payload)).toBe(true);

    const ev = await pool.query('SELECT status FROM event WHERE id = $1', [eventId]);
    expect(ev.rows[0].status).toBe('delivered');

    const attempts = await pool.query('SELECT * FROM delivery_attempt WHERE event_id = $1', [eventId]);
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0].status_code).toBe(200);
    expect(attempts.rows[0].attempt_number).toBe(1);
  });

  it('skips delivery entirely when the event is already delivered (idempotency guard)', async () => {
    const eventId = await seedEvent(Buffer.from('{}', 'utf8'), 'delivered');

    await processDelivery({ data: { eventId } });

    expect(received).toBeNull();
    const attempts = await pool.query('SELECT * FROM delivery_attempt WHERE event_id = $1', [eventId]);
    expect(attempts.rows).toHaveLength(0);
  });
});

// Independent receiver-side verification (recomputed from scratch, not reusing
// src/signing.js, so the test proves a third party can verify).
function receiverVerify(secret, headers, rawBody) {
  const timestamp = headers['x-webhook-timestamp'];
  const received = headers['x-webhook-signature'];
  if (!timestamp || !received) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return received === expected;
}

describe('HMAC signing', () => {
  it('sends id/timestamp headers and a signature the receiver can independently verify', async () => {
    const secret = 'a'.repeat(64);
    const payload = Buffer.from(JSON.stringify({ amount: 100 }), 'utf8');
    const eventId = await seedEvent(payload, 'pending', secret);

    await processDelivery({ data: { eventId } });

    expect(received.headers['x-webhook-id']).toBe(eventId);
    expect(received.headers['x-webhook-timestamp']).toMatch(/^\d+$/);
    expect(received.headers['x-webhook-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(receiverVerify(secret, received.headers, received.body)).toBe(true);
  });

  it('signature is over the exact raw bytes — a tampered body fails verification', async () => {
    const secret = 'b'.repeat(64);
    const payload = Buffer.from(JSON.stringify({ amount: 100 }), 'utf8');
    const eventId = await seedEvent(payload, 'pending', secret);

    await processDelivery({ data: { eventId } });

    const tampered = Buffer.concat([received.body, Buffer.from('!')]);
    expect(receiverVerify(secret, received.headers, tampered)).toBe(false);
    expect(receiverVerify(secret, received.headers, received.body)).toBe(true);
  });

  it('omits the signature header when the subscription has no secret', async () => {
    const eventId = await seedEvent(Buffer.from('{}', 'utf8'), 'pending', null);

    await processDelivery({ data: { eventId } });

    expect(received.headers['x-webhook-id']).toBe(eventId);
    expect(received.headers['x-webhook-signature']).toBeUndefined();
  });
});