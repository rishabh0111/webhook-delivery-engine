'use strict';

const { pool } = require('../../src/db');
const { runMigrations } = require('../../src/migrate');

async function setupDb() {
  await runMigrations(pool);
}

async function resetDb() {
  await pool.query(
    'TRUNCATE TABLE dead_letter, delivery_attempt, event, subscription RESTART IDENTITY CASCADE'
  );
}

async function teardownDb() {
  await pool.end();
}

module.exports = { pool, setupDb, resetDb, teardownDb };