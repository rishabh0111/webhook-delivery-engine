'use strict';

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  // Per-attempt HTTP delivery timeout (ms). Read at call time so tests can
  // shrink it to exercise the timeout path quickly.
  deliveryTimeoutMs: Number(process.env.DELIVERY_TIMEOUT_MS) || 10000,
  // Base delay (ms) for BullMQ's exponential backoff (â‰ˆ delay -> 2x -> 4x ...).
  backoffDelayMs: Number(process.env.BACKOFF_DELAY_MS) || 60 * 1000,
  logLevel:
    process.env.LOG_LEVEL ||
    (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
};

module.exports = config;