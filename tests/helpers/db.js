'use strict';

const { pool } = require('../../src/db');
const { runMigrations } = require('../../src/migrate');

// Ensure the schema exists. Migrations are idempotent, so calling this from
// every suite's beforeAll is safe and cheap after the first run.
async function setupDb() {
  await runMigrations(pool);
}

// Wipe all domain tables between tests so each test starts from a clean slate.
// RESTART IDENTITY + CASCADE keeps it simple. Only lists tables that exist as
// of THIS commit — TRUNCATE errors ("relation ... does not exist") if a listed
// table hasn't been migrated yet.
async function resetDb() {
  await pool.query('TRUNCATE TABLE subscription RESTART IDENTITY CASCADE');
}

// Release the shared pool so Jest can exit cleanly.
async function teardownDb() {
  await pool.end();
}

module.exports = { pool, setupDb, resetDb, teardownDb };