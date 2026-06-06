'use strict';

const express = require('express');
const db = require('../db');
const { connection } = require('../queue');

const router = express.Router();

// Shallow liveness check — the keep-alive target. MUST NOT touch Postgres/Redis.
router.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Deep readiness check, on demand only. Verifies Postgres and Redis; 503 if
// either is down. Kept separate so it is NOT on the keep-alive path.
router.get('/ready', async (req, res) => {
  const checks = { postgres: false, redis: false };

  try {
    await db.query('SELECT 1');
    checks.postgres = true;
  } catch (err) {
    req.log.warn({ err }, 'readiness: postgres check failed');
  }

  try {
    const pong = await connection.ping();
    checks.redis = pong === 'PONG';
  } catch (err) {
    req.log.warn({ err }, 'readiness: redis check failed');
  }

  const ready = checks.postgres && checks.redis;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
});

module.exports = router;