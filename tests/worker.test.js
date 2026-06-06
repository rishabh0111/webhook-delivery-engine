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