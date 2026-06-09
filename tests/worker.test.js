'use strict';

const http = require('http');
const crypto = require('crypto');
const { UnrecoverableError } = require('bullmq');
const config = require('../src/config');
const {
  processDelivery,
  deadLetterEvent,
  handleFailedJob,
} = require('../src/worker');
const { pool, setupDb, resetDb, teardownDb } = require('./helpers/db');
const { closeQueue } = require('./helpers/queue');

// A throwaway HTTP server the worker genuinely POSTs to — preferred over
// mocking fetch so the bytes-on-the-wire are exercised for real.
let server;
let baseUrl;
let received;
let nextStatus;
let nextDelayMs; // delay before responding, to exercise the client timeout
const originalTimeout = config.deliveryTimeoutMs;

beforeAll(async () => {
  await setupDb();
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = {
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      const respond = () => {
        res.statusCode = nextStatus;
        res.end('ok');
      };
      if (nextDelayMs > 0) {
        const timer = setTimeout(respond, nextDelayMs);
        // If the client aborts (timeout), drop the pending timer so the server
        // doesn't leak it between tests.
        req.on('close', () => clearTimeout(timer));
      } else {
        respond();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await resetDb();
  received = null;
  nextStatus = 200;
  nextDelayMs = 0;
  config.deliveryTimeoutMs = originalTimeout;
});

afterEach(() => {
  config.deliveryTimeoutMs = originalTimeout;
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

// Independent receiver-side verification, mirroring docs/signature-verification.md
// (recomputed from scratch here rather than reusing src/signing.js, so the test
// genuinely proves a third party can verify).
function receiverVerify(secret, headers, rawBody) {
  const timestamp = headers['x-webhook-timestamp'];
  const received = headers['x-webhook-signature'];
  if (!timestamp || !received) return false;
  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
  return received === expected;
}

describe('processDelivery (worker seam)', () => {
  it('POSTs raw_body to the target and marks the event delivered on 2xx, recording one attempt', async () => {
    const payload = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
    const eventId = await seedEvent(payload);

    await processDelivery({ data: { eventId, correlationId: 'test' } });

    // The receiver got the exact bytes, via POST.
    expect(received).not.toBeNull();
    expect(received.method).toBe('POST');
    expect(received.body.equals(payload)).toBe(true);

    const ev = await pool.query('SELECT status FROM event WHERE id = $1', [
      eventId,
    ]);
    expect(ev.rows[0].status).toBe('delivered');

    const attempts = await pool.query(
      'SELECT * FROM delivery_attempt WHERE event_id = $1',
      [eventId]
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0].status_code).toBe(200);
    expect(attempts.rows[0].attempt_number).toBe(1);
    expect(attempts.rows[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(attempts.rows[0].response_body).toBe('ok');
  });

  it('skips delivery entirely when the event is already delivered (idempotency guard)', async () => {
    const eventId = await seedEvent(
      Buffer.from('{}', 'utf8'),
      'delivered'
    );

    await processDelivery({ data: { eventId } });

    // No HTTP call, no new attempt row.
    expect(received).toBeNull();
    const attempts = await pool.query(
      'SELECT * FROM delivery_attempt WHERE event_id = $1',
      [eventId]
    );
    expect(attempts.rows).toHaveLength(0);
  });
});

describe('HMAC signing', () => {
  it('sends id/timestamp headers and a signature the receiver can independently verify', async () => {
    const secret = 'a'.repeat(64);
    const payload = Buffer.from(JSON.stringify({ amount: 100 }), 'utf8');
    const eventId = await seedEvent(payload, 'pending', secret);

    await processDelivery({ data: { eventId } });

    expect(received).not.toBeNull();
    // Stable id == event id; timestamp is unix seconds.
    expect(received.headers['x-webhook-id']).toBe(eventId);
    expect(received.headers['x-webhook-timestamp']).toMatch(/^\d+$/);
    expect(received.headers['x-webhook-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    // The receiver recomputes over the bytes it actually received and matches.
    expect(receiverVerify(secret, received.headers, received.body)).toBe(true);
  });

  it('signature is computed over the exact raw bytes — a tampered body fails verification', async () => {
    const secret = 'b'.repeat(64);
    const payload = Buffer.from(JSON.stringify({ amount: 100 }), 'utf8');
    const eventId = await seedEvent(payload, 'pending', secret);

    await processDelivery({ data: { eventId } });

    // Verifying against a mutated body must fail.
    const tampered = Buffer.concat([received.body, Buffer.from('!')]);
    expect(receiverVerify(secret, received.headers, tampered)).toBe(false);
    // ...but the untampered body still verifies, proving it's the body that matters.
    expect(receiverVerify(secret, received.headers, received.body)).toBe(true);
  });

  it('omits the signature header when the subscription has no secret', async () => {
    const eventId = await seedEvent(
      Buffer.from('{}', 'utf8'),
      'pending',
      null
    );

    await processDelivery({ data: { eventId } });

    expect(received).not.toBeNull();
    // Identity headers are still present...
    expect(received.headers['x-webhook-id']).toBe(eventId);
    expect(received.headers['x-webhook-timestamp']).toMatch(/^\d+$/);
    // ...but there is no signature to verify.
    expect(received.headers['x-webhook-signature']).toBeUndefined();
  });
});

// Job-shaped object for invoking the failed handler directly.
function jobLike(eventId, { attemptsMade = 1, attempts = 5 } = {}) {
  return { data: { eventId }, attemptsMade, opts: { attempts } };
}

async function catchReject(promise) {
  let err;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  return err;
}

async function countDeadLetters(eventId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM dead_letter WHERE event_id = $1',
    [eventId]
  );
  return rows[0].n;
}

async function eventStatus(eventId) {
  const { rows } = await pool.query('SELECT status FROM event WHERE id = $1', [
    eventId,
  ]);
  return rows[0].status;
}

describe('outcome classification, retries & dead-lettering', () => {
  it('5xx is transient: throws a retryable (non-Unrecoverable) error and records the attempt; status stays delivering', async () => {
    nextStatus = 503;
    const eventId = await seedEvent(Buffer.from('{}', 'utf8'));

    const err = await catchReject(processDelivery({ data: { eventId } }));
    expect(err).not.toBeInstanceOf(UnrecoverableError);

    const attempts = await pool.query(
      'SELECT * FROM delivery_attempt WHERE event_id = $1',
      [eventId]
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0].status_code).toBe(503);

    // Not yet terminal: still 'delivering', no dead_letter.
    expect(await eventStatus(eventId)).toBe('delivering');
    expect(await countDeadLetters(eventId)).toBe(0);
  });

  it('429 and 408 are treated as transient (retryable), not permanent', async () => {
    for (const status of [429, 408]) {
      nextStatus = status;
      const eventId = await seedEvent(Buffer.from('{}', 'utf8'));
      const err = await catchReject(processDelivery({ data: { eventId } }));
      expect(err).not.toBeInstanceOf(UnrecoverableError);
    }
  });

  it('transient failure across all attempts ends in a dead event with one dead_letter row', async () => {
    nextStatus = 500;
    const eventId = await seedEvent(Buffer.from('{}', 'utf8'));

    // Simulate BullMQ's retry loop: the processor runs `attempts` times, and
    // the failed handler runs after each — only dead-lettering when exhausted.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const err = await catchReject(processDelivery({ data: { eventId } }));
      await handleFailedJob(jobLike(eventId, { attemptsMade: attempt }), err);
    }

    expect(await eventStatus(eventId)).toBe('dead');
    expect(await countDeadLetters(eventId)).toBe(1);
    const attempts = await pool.query(
      'SELECT * FROM delivery_attempt WHERE event_id = $1 ORDER BY attempt_number',
      [eventId]
    );
    expect(attempts.rows).toHaveLength(5);
    expect(attempts.rows.map((a) => a.attempt_number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a permanent 4xx dead-letters immediately, before retries are exhausted', async () => {
    nextStatus = 404;
    const eventId = await seedEvent(Buffer.from('{}', 'utf8'));

    const err = await catchReject(processDelivery({ data: { eventId } }));
    expect(err).toBeInstanceOf(UnrecoverableError);

    // attemptsMade is only 1 of 5, but the UnrecoverableError makes it terminal.
    await handleFailedJob(jobLike(eventId, { attemptsMade: 1 }), err);

    expect(await eventStatus(eventId)).toBe('dead');
    expect(await countDeadLetters(eventId)).toBe(1);
    const attempts = await pool.query(
      'SELECT status_code FROM delivery_attempt WHERE event_id = $1',
      [eventId]
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0].status_code).toBe(404);
  });

  it('a slow endpoint aborts at the timeout and is treated as a retryable failure', async () => {
    config.deliveryTimeoutMs = 150;
    nextDelayMs = 600; // longer than the timeout
    nextStatus = 200;
    const eventId = await seedEvent(Buffer.from('{}', 'utf8'));

    const err = await catchReject(processDelivery({ data: { eventId } }));
    expect(err).not.toBeInstanceOf(UnrecoverableError);

    const attempts = await pool.query(
      'SELECT * FROM delivery_attempt WHERE event_id = $1',
      [eventId]
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0].status_code).toBeNull();
    expect(attempts.rows[0].error).toMatch(/timed out/i);
  });

  it('deadLetterEvent is guarded: it never clobbers a delivered event and never double-writes', async () => {
    // Delivered events are left alone.
    const delivered = await seedEvent(Buffer.from('{}', 'utf8'), 'delivered');
    expect(await deadLetterEvent(delivered, 'nope')).toBe(false);
    expect(await eventStatus(delivered)).toBe('delivered');
    expect(await countDeadLetters(delivered)).toBe(0);

    // First dead-letter writes a row; a repeat is a no-op.
    const ev = await seedEvent(Buffer.from('{}', 'utf8'), 'delivering');
    expect(await deadLetterEvent(ev, 'boom')).toBe(true);
    expect(await deadLetterEvent(ev, 'boom again')).toBe(false);
    expect(await eventStatus(ev)).toBe('dead');
    expect(await countDeadLetters(ev)).toBe(1);
  });
});
