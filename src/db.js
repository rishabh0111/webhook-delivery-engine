'use strict';

const { Pool } = require('pg');
const config = require('./config');

// A single shared connection pool for the process. Imported by routes, the
// migration runner, and (later slices) the worker and reconciler.
const pool = new Pool({ connectionString: config.databaseUrl });

module.exports = {
  pool,
  // Thin convenience wrapper so callers can `db.query(sql, params)` without
  // reaching for the pool directly.
  query: (text, params) => pool.query(text, params),
};