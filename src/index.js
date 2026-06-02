'use strict';

const app = require('./app');
const config = require('./config');
const logger = require('./logger');
const { pool } = require('./db');
const { runMigrations } = require('./migrate');

// Process entrypoint: run migrations, then start the HTTP server. Kept separate
// from app.js so Supertest can import the app without ever binding a port.
async function start() {
  await runMigrations(pool);

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'server listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      try {
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