'use strict';

const express = require('express');

const router = express.Router();

// Shallow liveness check. This is the keep-alive target an external uptime
// monitor pings (~every 5 min) to stop the free web instance spinning down, so
// it MUST NOT touch Postgres or Redis — otherwise the pings would keep the
// metered database awake and defeat free-tier autosuspend.
router.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

module.exports = router;