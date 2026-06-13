'use strict';

const db = require('./db');
const config = require('./config');
const { queue } = require('./queue');

const EVENT_STATUSES = ['pending', 'delivering', 'delivered', 'failed', 'dead'];

// Process-wide cache: { at, data }. The numbers are operator-facing
// approximations, not transactional reads. clearCache() exists for tests.
let cache = null;

function clearCache() {
  cache = null;
}

async function computeMetrics() {
  const [counts, eventRows] = await Promise.all([
    queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'paused'),
    db.query('SELECT status, COUNT(*)::int AS n FROM event GROUP BY status'),
  ]);

  const events = {};
  for (const status of EVENT_STATUSES) events[status] = 0;
  let total = 0;
  for (const row of eventRows.rows) {
    events[row.status] = row.n;
    total += row.n;
  }
  events.total = total;

  const queueCounts = {
    waiting: counts.waiting || 0,
    active: counts.active || 0,
    delayed: counts.delayed || 0,
    failed: counts.failed || 0,
    paused: counts.paused || 0,
  };
  queueCounts.depth = queueCounts.waiting + queueCounts.active + queueCounts.delayed;

  return { queue: queueCounts, events };
}

async function getMetrics() {
  const now = Date.now();
  if (cache && now - cache.at < config.metricsCacheTtlMs) {
    return { ...cache.data, generated_at: new Date(cache.at).toISOString(), cached: true };
  }
  const data = await computeMetrics();
  cache = { at: now, data };
  return { ...data, generated_at: new Date(now).toISOString(), cached: false };
}

module.exports = { getMetrics, computeMetrics, clearCache, EVENT_STATUSES };