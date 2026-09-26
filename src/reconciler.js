'use strict';

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const db = require('./db');
const config = require('./config');
const logger = require('./logger');
const { queue: deliveriesQueue, enqueueDelivery } = require('./queue');

const MAINTENANCE_QUEUE = 'maintenance';
const RECONCILE_JOB = 'reconcile';

// Job states that mean a delivery is still being handled by the queue — the
// reconciler must leave these alone.
const LIVE_STATES = new Set([
  'waiting',
  'waiting-children',
  'active',
  'delayed',
  'prioritized',
  'paused',
]);

// The outbox backstop. Finds non-terminal events the queue can't self-heal —
// a `pending` event whose enqueue never happened (crash between commit and
// enqueue), or a `delivering` event orphaned by Redis data loss — and
// re-enqueues them. Terminal events (`delivered`, `dead`) are never touched.
//
// Re-enqueue uses jobId = event.id, so an event that still has a live job is a
// harmless no-op; we additionally skip those up front to avoid disturbing a
// scheduled retry's backoff.
//
// Ages default from config but are overridable so tests can treat freshly
// seeded rows as stale.
async function reconcile(options = {}) {
  const pendingSeconds =
    (options.pendingAgeMs ?? config.reconcilePendingAgeMs) / 1000;
  const deliveringSeconds =
    (options.deliveringAgeMs ?? config.reconcileDeliveringAgeMs) / 1000;

  const { rows } = await db.query(
    `SELECT id FROM event
     WHERE (status = 'pending'    AND updated_at < now() - make_interval(secs => $1))
        OR (status = 'delivering' AND updated_at < now() - make_interval(secs => $2))`,
    [pendingSeconds, deliveringSeconds]
  );

  let reEnqueued = 0;
  for (const { id } of rows) {
    const job = await deliveriesQueue.getJob(id);
    if (job) {
      const state = await job.getState();
      if (LIVE_STATES.has(state)) {
        continue; // a live job is already handling this event
      }
      // A stale completed/failed job with this id would make re-add a no-op,
      // so clear it first (same gotcha the replay path handles).
      await job.remove();
    }
    await enqueueDelivery(id, 'reconciler');
    reEnqueued += 1;
  }

  if (reEnqueued > 0) {
    logger.info({ scanned: rows.length, reEnqueued }, 'reconciler re-enqueued events');
  }
  return { scanned: rows.length, reEnqueued };
}

// Wire the repeatable reconciler job and the worker that runs it. Kept on a
// dedicated maintenance queue so it doesn't interleave with delivery jobs.
function createReconciler() {
  const connection = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(MAINTENANCE_QUEUE, { connection });
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async () => {
      await reconcile();
    },
    { connection }
  );
  worker.on('failed', (job, err) =>
    logger.error({ err }, 'reconciler run failed')
  );
  return { queue, worker, connection };
}

// Register the ~15-minute repeatable job. BullMQ dedups repeatables by their
// name + repeat options, so calling this on every boot is idempotent.
async function scheduleReconciler(queue) {
  await queue.add(
    RECONCILE_JOB,
    {},
    { repeat: { every: config.reconcileIntervalMs } }
  );
}

// The schedule is itself Redis state: a FLUSHALL (or a Redis that comes back
// empty) deletes it, and the backstop meant to recover from Redis loss would
// never run again until the process restarts. Re-register it when it's
// missing, and report that it was, so the caller can sweep straight away.
async function ensureReconcilerScheduled(queue) {
  if ((await queue.getJobSchedulersCount()) > 0) {
    return false;
  }
  await scheduleReconciler(queue);
  return true;
}

// Every `reconcileWatchdogMs`, check the schedule survived. If it didn't,
// Redis lost data, so the jobs for pending events went with it: sweep now
// rather than wait out a full interval. Pending events of any age are safe to
// re-enqueue (jobId = event.id dedups against an enqueue still in flight);
// `delivering` keeps its age guard because a worker may still hold it.
function startReconcilerWatchdog(queue) {
  const timer = setInterval(async () => {
    try {
      if (await ensureReconcilerScheduled(queue)) {
        logger.warn('reconciler schedule was missing (Redis data loss?); re-registered it, sweeping now');
        await reconcile({ pendingAgeMs: 0 });
      }
    } catch (err) {
      logger.error({ err }, 'reconciler watchdog failed');
    }
  }, config.reconcileWatchdogMs);
  timer.unref();
  return timer;
}

module.exports = {
  MAINTENANCE_QUEUE,
  RECONCILE_JOB,
  reconcile,
  createReconciler,
  scheduleReconciler,
  ensureReconcilerScheduled,
  startReconcilerWatchdog,
};
