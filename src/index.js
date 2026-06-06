'use strict';

const app = require('./app');
const config = require('./config');
const logger = require('./logger');
const { pool } = require('./db');
const { runMigrations } = require('./migrate');
const { queue, connection } = require('./queue');
const { createWorker } = require('./worker');

// Run migrations, then start the HTTP server AND the BullMQ worker in this one
// process (the free host offers no separate background worker).
async function start() {
  await runMigrations(pool);

  const worker = createWorker();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'server listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      try {
        await worker.close();
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