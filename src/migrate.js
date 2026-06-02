'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const logger = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// Apply every .sql file in migrations/ that hasn't run yet, in filename order.
// Each migration runs inside a transaction together with the bookkeeping
// insert, so a migration and its record commit (or roll back) atomically.
// Safe to run repeatedly — already-applied files are skipped.
async function runMigrations(targetPool = pool) {
  await targetPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await targetPool.query('SELECT name FROM schema_migrations')).rows.map(
      (r) => r.name
    )
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await targetPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
        file,
      ]);
      await client.query('COMMIT');
      logger.info({ migration: file }, 'applied migration');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, migration: file }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { runMigrations };

// Allow `node src/migrate.js` as a standalone CLI.
if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .then(() => {
      logger.info('migrations complete');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'migration run failed');
      process.exit(1);
    });
}