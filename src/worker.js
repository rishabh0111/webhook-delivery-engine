'use strict';

const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const { QUEUE_NAME } = require('./queue');
const { buildSignatureHeaders } = require('./signing');

// Response bodies are recorded truncated (~2KB) for debugging.
const RESPONSE_BODY_LIMIT = 2048;

// Deliver one event to its subscription's target URL. Takes a plain job-shaped
// object so tests can invoke it directly against a real fake-receiver server.
async function processDelivery(job) {
  const { eventId, correlationId } = job.data;
  const log = logger.child({ eventId, correlationId });

  const { rows: eventRows } = await db.query('SELECT * FROM event WHERE id = $1', [eventId]);
  const event = eventRows[0];
  if (!event) {
    throw new Error(`event ${eventId} not found`);
  }

  // Idempotency guard: at-least-once delivery means a job can re-run after the
  // event was already delivered. Skip silently rather than double-deliver.
  if (event.status === 'delivered') {
    log.info('event already delivered; skipping');
    return;
  }

  const { rows: subRows } = await db.query('SELECT * FROM subscription WHERE id = $1', [event.subscription_id]);
  const subscription = subRows[0];
  if (!subscription) {
    throw new Error(`subscription ${event.subscription_id} not found`);
  }

  await db.query("UPDATE event SET status = 'delivering', updated_at = now() WHERE id = $1", [eventId]);

  // attempt_number is monotonic per event and append-only across replays.
  const { rows: numRows } = await db.query(
    'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM delivery_attempt WHERE event_id = $1',
    [eventId]
  );
  const attemptNumber = numRows[0].n;

  // Identity + signing headers. webhook-id = event id so it is stable across
  // retries and replays. The signature (when the subscription has a secret) is
  // computed over the exact raw_body bytes plus the timestamp we send.
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = {
    'content-type': 'application/json',
    ...buildSignatureHeaders({
      webhookId: event.id,
      timestamp,
      secret: subscription.secret,
      rawBody: event.raw_body,
    }),
  };

  const timeoutMs = config.deliveryTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  let statusCode = null;
  let responseBody = null;
  let errorText = null;

  try {
    const res = await fetch(subscription.target_url, {
      method: 'POST',
      body: event.raw_body, // exact stored bytes (a Buffer)
      headers,
      signal: controller.signal,
    });
    statusCode = res.status;
    const text = await res.text();
    responseBody = text.slice(0, RESPONSE_BODY_LIMIT);
  } catch (err) {
    errorText =
      err.name === 'AbortError'
        ? `request timed out after ${timeoutMs}ms`
        : String(err.message || err);
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;

  await db.query(
    `INSERT INTO delivery_attempt
       (event_id, attempt_number, status_code, duration_ms, response_body, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [eventId, attemptNumber, statusCode, durationMs, responseBody, errorText]
  );

  if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
    await db.query("UPDATE event SET status = 'delivered', updated_at = now() WHERE id = $1", [eventId]);
    log.info({ statusCode, durationMs }, 'delivered');
    return;
  }

  // Anything else is a failure — throw so BullMQ retries. (Outcome
  // classification and dead-lettering arrive in commit 5.)
  throw new Error(errorText || `delivery failed: status ${statusCode}`);
}

// Start a BullMQ worker bound to its own Redis connection.
function createWorker() {
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker(QUEUE_NAME, processDelivery, {
    connection,
    concurrency: 5,
    stalledInterval: 30000,
    maxStalledCount: 2,
  });
  worker.on('completed', (job) => logger.info({ jobId: job.id }, 'delivery job completed'));
  worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err }, 'delivery job failed'));
  return worker;
}

module.exports = { processDelivery, createWorker };