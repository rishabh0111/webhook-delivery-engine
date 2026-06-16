'use strict';

const config = require('./config');

// Gate the demo-only surfaces. Mounted unconditionally but 404s per-request
// when demo is disabled, so the routes simply don't exist in production
// (DEMO_MODE unset) while staying easy to flip in tests via config.demoEnabled.
function requireDemo(req, res, next) {
  if (!config.demoEnabled) {
    return res.status(404).json({ error: { message: 'Not found' } });
  }
  return next();
}

module.exports = { requireDemo };
