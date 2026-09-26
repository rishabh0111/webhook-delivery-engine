'use strict';

const app = require('./app');
const config = require('./config');
const logger = require('./logger');
const { pool } = require('./db');
const { runMigrations } = require('./migrate');
const { queue, connection } = require('./queue');
const { createWorker } = require('./worker');
const {
  createReconciler,
  scheduleReconciler,
  startReconcilerWatchdog,
} = require('./reconciler');

async function start() {
  await runMigrations(pool);

  const worker = createWorker();

  // Outbox backstop: a repeatable job sweeps for orphaned non-terminal events.
  const reconciler = createReconciler();
  await scheduleReconciler(reconciler.queue);
  // ...and a watchdog, because that schedule is lost with the rest of Redis.
  const watchdog = startReconcilerWatchdog(reconciler.queue);

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'server listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(watchdog);
    server.close(async () => {
      try {
        await worker.close();
        await reconciler.worker.close();
        await reconciler.queue.close();
        reconciler.connection.disconnect();
        await queue.close();
        connection.disconnect();
        await pool.end();
      } finally {
        process.exit(0);
      }
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});