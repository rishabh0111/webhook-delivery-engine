'use strict';

const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const config = require('./config');

const QUEUE_NAME = 'deliveries';

// Shared Redis connection for producer-side ops (enqueue) and the readiness
// ping. lazyConnect means no socket until the first command; maxRetriesPerRequest
// null is required by BullMQ.
const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

const queue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    // 5 attempts with exponential backoff (â‰ˆ 60s -> 120s -> 240s -> 480s).
    attempts: 5,
    // was: backoff: { type: 'exponential', delay: 60000 },
    backoff: { type: 'exponential', delay: config.backoffDelayMs },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

// jobId = eventId makes a duplicate enqueue a no-op, which is what lets the
// ingestion path tolerate a false-negative enqueue (the durable point of no
// return is the Postgres commit, not this call).
async function enqueueDelivery(eventId, correlationId) {
  return queue.add('deliver', { eventId, correlationId }, { jobId: eventId });
}

module.exports = { QUEUE_NAME, queue, connection, enqueueDelivery };