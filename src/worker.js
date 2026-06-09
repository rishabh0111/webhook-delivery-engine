'use strict';

const { Worker, UnrecoverableError } = require('bullmq');
const IORedis = require('ioredis');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const { QUEUE_NAME } = require('./queue');
const { buildSignatureHeaders } = require('./signing');

const RESPONSE_BODY_LIMIT = 2048;

// True if a non-2xx status is permanent (dead-letter now, no retry). 408 and
// 429 are treated as transient even though they're 4xx.
function isPermanentStatus(statusCode) {
  return statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
}

async function processDelivery(job) {
  const { eventId, correlationId } = job.data;
  const log = logger.child({ eventId, correlationId });

  const { rows: eventRows } = await db.query('SELECT * FROM event WHERE id = $1', [eventId]);
  const event = eventRows[0];
  if (!event) {
    throw new Error(`event ${eventId} not found`);
  }

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

  const { rows: numRows } = await db.query(
    'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM delivery_attempt WHERE event_id = $1',
    [eventId]
  );
  const attemptNumber = numRows[0].n;

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
    await db.query("UPDATE event SET status = 'delivered', updated_at = now() WHERE id = $1", [eventId]);
    log.info({ statusCode, durationMs }, 'delivered');
    return;
  }

  // Permanent client error -> dead-letter immediately, no further attempts.
  if (statusCode !== null && isPermanentStatus(statusCode)) {
    log.warn({ statusCode }, 'permanent failure; dead-lettering');
    throw new UnrecoverableError(`permanent failure: status ${statusCode}`);
  }

  // Everything else (timeout, network, 408/429, 5xx) is transient -> a normal
  // Error so BullMQ reschedules with backoff.
  throw new Error(errorText || `retryable response: status ${statusCode}`);
}

// Mark an event dead and write its dead_letter row. Idempotent and guarded on
// status: won't clobber a delivered event, won't write a second row if dead.
async function deadLetterEvent(eventId, reason) {
  const { rowCount } = await db.query(
    `UPDATE event SET status = 'dead', updated_at = now()
     WHERE id = $1 AND status NOT IN ('dead', 'delivered')`,
    [eventId]
  );
  if (rowCount === 0) {
    return false;
  }
  await db.query('INSERT INTO dead_letter (event_id, reason) VALUES ($1, $2)', [
    eventId,
    reason ? String(reason).slice(0, 1000) : null,
  ]);
  return true;
}

// BullMQ 'failed' handler logic. Fires on every failed attempt, so we only
// dead-letter when terminal: an UnrecoverableError, or the last allowed attempt.
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

function createWorker() {
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker(QUEUE_NAME, processDelivery, {
    connection,
    concurrency: 5,
    stalledInterval: 30000,
    maxStalledCount: 2,
  });
  worker.on('completed', (job) => logger.info({ jobId: job.id }, 'delivery job completed'));
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

module.exports = { processDelivery, createWorker, deadLetterEvent, handleFailedJob };