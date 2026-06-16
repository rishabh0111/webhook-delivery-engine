'use strict';

const { Worker, UnrecoverableError } = require('bullmq');
const IORedis = require('ioredis');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const demoState = require('./demo-state');
const { QUEUE_NAME } = require('./queue');
const { buildSignatureHeaders } = require('./signing');

// Response bodies are recorded truncated (~2KB) for debugging.
const RESPONSE_BODY_LIMIT = 2048;

// Decide what a non-2xx HTTP response means. Returns true if the status is
// permanent (dead-letter immediately, no retry). 408 (timeout) and 429 (rate
// limit) are treated as transient even though they're 4xx; everything else in
// the 4xx range is a permanent client error.
function isPermanentStatus(statusCode) {
  return statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
}

// Deliver one event to its subscription's target URL. This is the BullMQ job
// processor, but it takes a plain job-shaped object so tests can invoke it
// directly against a real fake-receiver HTTP server (no queue required).
//
// Outcome classification:
//   2xx                                   -> mark delivered, return
//   timeout / network / 429 / 408 / 5xx   -> throw Error (BullMQ retries)
//   other 4xx                             -> throw UnrecoverableError (dies now)
// Every attempt (success or failure) is recorded as a delivery_attempt.
async function processDelivery(job) {
  const { eventId, correlationId } = job.data;
  const log = logger.child({ eventId, correlationId });

  const { rows: eventRows } = await db.query(
    'SELECT * FROM event WHERE id = $1',
    [eventId]
  );
  const event = eventRows[0];
  if (!event) {
    throw new Error(`event ${eventId} not found`);
  }

  // Idempotency guard: at-least-once delivery means a job can be re-run after
  // the event was already delivered. Skip silently rather than double-deliver.
  if (event.status === 'delivered') {
    log.info('event already delivered; skipping');
    return;
  }

  const { rows: subRows } = await db.query(
    'SELECT * FROM subscription WHERE id = $1',
    [event.subscription_id]
  );
  const subscription = subRows[0];
  if (!subscription) {
    throw new Error(`subscription ${event.subscription_id} not found`);
  }

  await db.query(
    "UPDATE event SET status = 'delivering', updated_at = now() WHERE id = $1",
    [eventId]
  );

  // attempt_number is monotonic per event and append-only across replays.
  const { rows: numRows } = await db.query(
    'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM delivery_attempt WHERE event_id = $1',
    [eventId]
  );
  const attemptNumber = numRows[0].n;

  // Identity + signing headers. webhook-id = event id so it is stable across
  // retries and replays, letting receivers dedup at-least-once deliveries.
  // The signature (when the subscription has a secret) is computed over the
  // exact raw_body bytes plus the timestamp we send.
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

  // Read the timeout at call time (honors the runtime demo "fast mode"; falls
  // through to config.deliveryTimeoutMs otherwise, so tests can shrink it).
  const timeoutMs = demoState.deliveryTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  let statusCode = null;
  let responseBody = null;
  let errorText = null;

  try {
    const res = await fetch(subscription.target_url, {
      method: 'POST',
      // raw_body is the exact stored bytes (a Buffer); send verbatim.
      body: event.raw_body,
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

  // 2xx -> success.
  if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
    await db.query(
      "UPDATE event SET status = 'delivered', updated_at = now() WHERE id = $1",
      [eventId]
    );
    log.info({ statusCode, durationMs }, 'delivered');
    return;
  }

  // Permanent client error -> dead-letter immediately, no further attempts.
  if (statusCode !== null && isPermanentStatus(statusCode)) {
    log.warn({ statusCode }, 'permanent failure; dead-lettering');
    throw new UnrecoverableError(`permanent failure: status ${statusCode}`);
  }

  // Everything else (timeout, network error, 408/429, 5xx, unexpected) is
  // transient -> a normal Error so BullMQ reschedules with backoff.
  throw new Error(errorText || `retryable response: status ${statusCode}`);
}

// Mark an event dead and write its dead_letter row. Idempotent and guarded on
// status: it won't clobber a delivered event and won't write a second row if
// the event is already dead.
async function deadLetterEvent(eventId, reason) {
  const { rowCount } = await db.query(
    `UPDATE event SET status = 'dead', updated_at = now()
     WHERE id = $1 AND status NOT IN ('dead', 'delivered')`,
    [eventId]
  );
  if (rowCount === 0) {
    return false;
  }
  await db.query(
    'INSERT INTO dead_letter (event_id, reason) VALUES ($1, $2)',
    [eventId, reason ? String(reason).slice(0, 1000) : null]
  );
  return true;
}

// BullMQ 'failed' handler logic. Fires on every failed attempt, so we only
// dead-letter when the failure is terminal: either an UnrecoverableError (no
// retries) or the last allowed attempt.
async function handleFailedJob(job, err) {
  if (!job) return;
  const unrecoverable =
    err instanceof UnrecoverableError || err?.name === 'UnrecoverableError';
  const exhausted = job.attemptsMade >= (job.opts?.attempts || 1);
  if (!unrecoverable && !exhausted) {
    return; // will be retried
  }
  await deadLetterEvent(job.data.eventId, err?.message || 'delivery failed');
}

// Start a BullMQ worker bound to its own Redis connection. Kept separate from
// queue.js's producer connection because BullMQ workers issue blocking
// commands and want a dedicated connection.
function createWorker() {
  const connection = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
  });
  const worker = new Worker(QUEUE_NAME, processDelivery, {
    connection,
    // Enough that one slow receiver doesn't block the queue, low enough to fit
    // the free instance's memory.
    concurrency: 5,
    // A worker killed mid-delivery has its job re-attempted (stalled) rather
    // than instantly failed.
    stalledInterval: 30000,
    maxStalledCount: 2,
  });
  worker.on('completed', (job) =>
    logger.info({ jobId: job.id }, 'delivery job completed')
  );
  worker.on('failed', async (job, err) => {
    logger.warn({ jobId: job?.id, err }, 'delivery job failed');
    try {
      await handleFailedJob(job, err);
    } catch (handlerErr) {
      logger.error({ err: handlerErr, jobId: job?.id }, 'dead-letter handler failed');
    }
  });
  return worker;
}

module.exports = {
  processDelivery,
  createWorker,
  deadLetterEvent,
  handleFailedJob,
};
