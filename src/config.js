'use strict';

// Central configuration, read once from the environment. Keeping this in one
// place means routes/db/logger never reach into process.env directly.
const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  // Per-attempt HTTP delivery timeout (ms). Read at call time so tests can
  // shrink it to exercise the timeout path quickly.
  deliveryTimeoutMs: Number(process.env.DELIVERY_TIMEOUT_MS) || 10000,

  // Base delay (ms) for BullMQ's exponential backoff (≈ delay -> 2x -> 4x ...).
  // This is the PRODUCTION default; the dashboard's demo "fast mode" overrides
  // it at runtime via src/demo-state.js without changing this value.
  backoffDelayMs: Number(process.env.BACKOFF_DELAY_MS) || 60 * 1000,

  // Whether the in-process demo aids (the controllable receiver, the seed /
  // reset / reconcile controls, and the runtime timing toggle) are mounted.
  // Explicit DEMO_MODE wins; otherwise on everywhere except production, so the
  // live portfolio deploy opts in by setting DEMO_MODE=true.
  demoEnabled: process.env.DEMO_MODE
    ? /^(1|true|yes|on)$/i.test(process.env.DEMO_MODE)
    : process.env.NODE_ENV !== 'production',

  // Reconciler: runs deliberately infrequently so the database can autosuspend
  // between sweeps (free-tier compute discipline).
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS) || 15 * 60 * 1000,
  // An event must be at least this old before the reconciler will touch it,
  // so we don't race a delivery that's mid-flight.
  reconcilePendingAgeMs: Number(process.env.RECONCILE_PENDING_AGE_MS) || 60 * 1000,
  reconcileDeliveringAgeMs:
    Number(process.env.RECONCILE_DELIVERING_AGE_MS) || 5 * 60 * 1000,
  // /metrics is cached this long so a left-open dashboard tab (polling ~every
  // 10s) does not hammer Postgres/Redis on every refresh — protecting the
  // free-tier compute budget. Read at call time so tests can disable it.
  metricsCacheTtlMs: Number(process.env.METRICS_CACHE_TTL_MS) || 10 * 1000,
  // Default to silent during tests so the suite output stays readable.
  logLevel:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
};

module.exports = config;
