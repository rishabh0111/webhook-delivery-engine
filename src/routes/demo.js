'use strict';

const express = require('express');
const db = require('../db');
const { requireDemo } = require('../demo-guard');
const demoState = require('../demo-state');
const store = require('../demo-store');
const { seedDemo } = require('../seed');
const { reconcile } = require('../reconciler');

// Operator-facing demo controls (DEMO_MODE only): the runtime timing toggle,
// one-click seed, a reset for a clean slate between runs, and an on-demand
// reconciler trigger so the outbox backstop can be shown without waiting ~15
// minutes for its scheduled sweep.
const router = express.Router();
router.use(requireDemo);

// GET /api/demo/settings — current runtime demo settings.
router.get('/settings', (req, res) => {
  res.status(200).json(demoState.snapshot());
});

// POST /api/demo/settings — flip "fast mode" live (compressed backoff + delivery
// timeout) without an env change or redeploy.
router.post('/settings', (req, res) => {
  if (typeof req.body?.fastMode === 'boolean') {
    demoState.setFastMode(req.body.fastMode);
  }
  res.status(200).json(demoState.snapshot());
});

// POST /api/demo/seed — idempotently create the demo subscriptions and return
// the scenario map the dashboard's one-click buttons use.
router.post('/seed', async (req, res, next) => {
  try {
    res.status(200).json(await seedDemo());
  } catch (err) {
    next(err);
  }
});

// POST /api/demo/reset — clear the event tables (keep subscriptions) and the
// receiver's transient state, for a clean slate between demo runs.
router.post('/reset', async (req, res, next) => {
  try {
    await db.query(
      'TRUNCATE TABLE dead_letter, delivery_attempt, event RESTART IDENTITY CASCADE'
    );
    store.reset();
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/demo/reconcile — run the outbox backstop now, treating every
// non-terminal event as stale (age thresholds = 0) so a seeded "stuck" event is
// re-enqueued immediately.
router.post('/reconcile', async (req, res, next) => {
  try {
    res
      .status(200)
      .json(await reconcile({ pendingAgeMs: 0, deliveringAgeMs: 0 }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
