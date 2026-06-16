'use strict';

const { computeSignature } = require('./signing');

// Process-local state backing the in-process demo receiver. All of it is a demo
// aid and resets on restart:
//   - `secrets`: the signing secrets of seeded demo subscriptions, so the
//     receiver can verify the HMAC the engine sent (a real receiver knows its
//     own secret out of band; here the seed shares it in-process).
//   - `flakyCounts`: per-webhook-id attempt counters for the flaky endpoint.
//   - `recent`: a ring buffer of recently received deliveries for the dashboard.
const secrets = new Set();
const flakyCounts = new Map();
const recent = [];
const RECENT_LIMIT = 50;

// Register a demo subscription's secret so the receiver can verify signatures.
function registerSecret(secret) {
  if (secret) secrets.add(secret);
}

// Verify a delivery's signature against any known demo secret.
// Returns true/false when a signature header is present, or null when the
// delivery was unsigned (no header — a valid state for keyless subscriptions).
function verifySignature(signatureHeader, timestamp, rawBody) {
  if (!signatureHeader) return null;
  const expected = String(signatureHeader).replace(/^sha256=/, '');
  for (const secret of secrets) {
    if (computeSignature(secret, timestamp, rawBody) === expected) {
      return true;
    }
  }
  return false;
}

// The flaky endpoint fails the first `fails` attempts per webhook id, then
// succeeds. Returns the 1-based attempt number so the caller can decide.
function nextFlakyAttempt(webhookId) {
  const key = webhookId || 'no-id';
  const n = (flakyCounts.get(key) || 0) + 1;
  flakyCounts.set(key, n);
  return n;
}

// Record a received delivery for the dashboard's receiver view (newest first).
function pushRecent(entry) {
  recent.unshift({ ...entry, received_at: new Date().toISOString() });
  if (recent.length > RECENT_LIMIT) recent.pop();
}

function recentDeliveries() {
  return recent.slice();
}

// Clear transient receiver state (flaky counters + log) — used by demo reset
// and tests. Secrets are kept unless `all` is set (full reset for tests).
function reset(all = false) {
  flakyCounts.clear();
  recent.length = 0;
  if (all) secrets.clear();
}

module.exports = {
  registerSecret,
  verifySignature,
  nextFlakyAttempt,
  pushRecent,
  recentDeliveries,
  reset,
};
