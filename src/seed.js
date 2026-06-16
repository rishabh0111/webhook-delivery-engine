'use strict';

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const store = require('./demo-store');

// The demo subscriptions, one per receiver behavior. Each is matched/created by
// its (stable) description so seeding is idempotent — re-running reuses the
// existing row rather than duplicating it.
const DEMO_SUBSCRIPTIONS = [
  { key: 'signedOk', description: 'Demo: always 200 (signed)', path: '/demo/receiver/ok', signed: true },
  { key: 'unsignedOk', description: 'Demo: always 200 (unsigned)', path: '/demo/receiver/ok', signed: false },
  { key: 'flaky', description: 'Demo: flaky then 200 (signed)', path: '/demo/receiver/flaky/2', signed: true },
  { key: 'slow', description: 'Demo: slow / timeout (signed)', path: '/demo/receiver/slow', signed: true },
  { key: 'reject', description: 'Demo: 401 permanent (signed)', path: '/demo/receiver/reject', signed: true },
  { key: 'down', description: 'Demo: 503 transient (signed)', path: '/demo/receiver/down', signed: true },
];

// Default the receiver base URL to this same process over loopback — the
// receiver IS this app, so 127.0.0.1:<port> always reaches it (local and on the
// single live instance). PUBLIC_BASE_URL overrides it if needed.
function defaultBaseUrl() {
  return process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${config.port}`;
}

// Idempotently create the demo subscriptions pointed at the in-process demo
// receiver, registering each signing secret with the receiver so it can verify
// the HMACs the engine sends. Returns a scenario-key -> subscription map the
// dashboard's one-click buttons use.
async function seedDemo(options = {}) {
  const baseUrl = (options.baseUrl || defaultBaseUrl()).replace(/\/$/, '');
  const subscriptions = {};

  for (const spec of DEMO_SUBSCRIPTIONS) {
    const targetUrl = `${baseUrl}${spec.path}`;

    const existing = await db.query(
      'SELECT id, secret FROM subscription WHERE description = $1 LIMIT 1',
      [spec.description]
    );

    let id;
    let secret;
    if (existing.rowCount > 0) {
      id = existing.rows[0].id;
      secret = existing.rows[0].secret;
      // Keep the target URL current in case the base URL changed between runs.
      await db.query('UPDATE subscription SET target_url = $1 WHERE id = $2', [
        targetUrl,
        id,
      ]);
    } else {
      secret = spec.signed ? crypto.randomBytes(32).toString('hex') : null;
      const inserted = await db.query(
        `INSERT INTO subscription (target_url, secret, description)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [targetUrl, secret, spec.description]
      );
      id = inserted.rows[0].id;
    }

    store.registerSecret(secret);
    subscriptions[spec.key] = {
      id,
      description: spec.description,
      target_url: targetUrl,
      signed: Boolean(secret),
    };
  }

  return { baseUrl, subscriptions };
}

module.exports = { seedDemo, DEMO_SUBSCRIPTIONS };

// CLI entry: `npm run seed`. Ensure the schema exists, seed, print, exit.
if (require.main === module) {
  /* eslint-disable no-console */
  const { pool } = require('./db');
  const { runMigrations } = require('./migrate');
  (async () => {
    try {
      await runMigrations(pool);
      const result = await seedDemo();
      console.log('Seeded demo subscriptions:');
      for (const [key, sub] of Object.entries(result.subscriptions)) {
        console.log(`  ${key.padEnd(11)} ${sub.id}  ${sub.target_url}`);
      }
    } catch (err) {
      console.error('Seed failed:', err);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
