'use strict';

const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const config = require('./config');
const demoState = require('./demo-state');

const QUEUE_NAME = 'deliveries';

// Shared Redis connection for producer-side ops (enqueue) and the readiness
// ping. lazyConnect means no socket is opened until the first command, which
// keeps modules that merely import this file (e.g. the shallow /health route)
// from holding an open connection. maxRetriesPerRequest:null is required by
// BullMQ.
const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

const queue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    // BullMQ owns retry scheduling: 5 attempts with exponential backoff. The
    // base delay defaults to config.backoffDelayMs (≈ 60s -> 120s -> 240s ->
    // 480s in production) but enqueueDelivery overrides it per-job from the
    // runtime demo setting, so a flipped "fast mode" takes effect immediately.
    attempts: 5,
    backoff: { type: 'exponential', delay: config.backoffDelayMs },
    // Drop succeeded jobs to stay within the memory-metered Redis budget;
    // keep failed jobs so a dead-lettered event can be replayed (the replay
    // path removes the stale failed job before re-adding).
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// Enqueue a delivery job. jobId = eventId makes a duplicate enqueue a no-op,
// which is what lets the ingestion path tolerate a false-negative enqueue
// (the durable point of no return is the Postgres commit, not this call).
async function enqueueDelivery(eventId, correlationId) {
  return queue.add(
    'deliver',
    { eventId, correlationId },
    {
      jobId: eventId,
      // Per-job backoff from the runtime demo setting (production base unless
      // fast mode is on). Set per-job so the dashboard toggle affects new jobs
      // without a restart; in-flight retries keep their original schedule.
      backoff: { type: 'exponential', delay: demoState.backoffDelayMs() },
    }
  );
}

module.exports = { QUEUE_NAME, queue, connection, enqueueDelivery };
