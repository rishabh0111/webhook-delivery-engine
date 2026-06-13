'use strict';

const express = require('express');
const { getMetrics } = require('../metrics');

const router = express.Router();

// GET /metrics — queue depth (Redis) + event counts by status (Postgres),
// served from a ~10s cache. See src/metrics.js for the caching.
router.get('/', async (req, res, next) => {
  try {
    res.status(200).json(await getMetrics());
  } catch (err) {
    next(err);
  }
});

module.exports = router;