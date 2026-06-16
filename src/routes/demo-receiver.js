'use strict';

const express = require('express');
const { requireDemo } = require('../demo-guard');
const store = require('../demo-store');

// In-process demo receiver: the controllable destination the engine delivers to
// so every outcome path (success, permanent failure, transient failure ->
// retry, timeout, flaky -> eventual success) can be demonstrated end-to-end
// without an external service. It is a DEMO AID, not part of the delivery
// engine — gated behind DEMO_MODE.
//
// Each handler records what it received (webhook id, timestamp, the status it
// returned, and whether the HMAC verified against a known demo secret) so the
// dashboard can show "the receiver saw it, signature valid: ✓".
const router = express.Router();
router.use(requireDemo);

// Record one received delivery, then respond with the chosen status. The body
// is the exact raw bytes (express.raw is mounted for this router in app.js), so
// the signature check runs over the same bytes the engine signed.
function recordAndRespond(req, res, statusCode, body = String(statusCode)) {
  const webhookId = req.get('x-webhook-id') || null;
  const timestamp = req.get('x-webhook-timestamp') || null;
  const signatureHeader = req.get('x-webhook-signature') || null;
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

  store.pushRecent({
    path: req.path,
    webhook_id: webhookId,
    timestamp,
    status_returned: statusCode,
    signature_valid: store.verifySignature(signatureHeader, timestamp, rawBody),
  });

  res.status(statusCode).send(body);
}

// 2xx — the receiver accepts. -> event delivered.
router.post('/ok', (req, res) => recordAndRespond(req, res, 200, 'ok'));

// 401 — a permanent client error. -> dead-lettered immediately, no retries.
router.post('/reject', (req, res) =>
  recordAndRespond(req, res, 401, 'unauthorized')
);

// 503 — a transient server error. -> retried with backoff, then dead-lettered
// once attempts are exhausted.
router.post('/down', (req, res) =>
  recordAndRespond(req, res, 503, 'service unavailable')
);

// Never responds in time — exercises the engine's per-attempt timeout, which
// aborts and treats it as transient (-> retry). The pending timer is cleared if
// the client aborts, so it does not leak between deliveries.
router.post('/slow', (req, res) => {
  const HANG_MS = 15000; // exceeds both the demo (3s) and production (10s) timeout
  const timer = setTimeout(
    () => recordAndRespond(req, res, 200, 'ok (eventually)'),
    HANG_MS
  );
  req.on('close', () => clearTimeout(timer));
});

// Fails the first `:fails` attempts per webhook id with 503, then succeeds —
// the canonical "transient outage, then recovery" path that proves retries
// converge instead of giving up.
router.post('/flaky/:fails', (req, res) => {
  const fails = Math.max(0, Number(req.params.fails) || 0);
  const attempt = store.nextFlakyAttempt(req.get('x-webhook-id'));
  if (attempt <= fails) {
    return recordAndRespond(req, res, 503, `flaky: attempt ${attempt} fails`);
  }
  return recordAndRespond(req, res, 200, `flaky: attempt ${attempt} ok`);
});

// What the receiver has seen recently, newest first — drives the dashboard's
// receiver/verification view.
router.get('/log', (req, res) => {
  res.status(200).json(store.recentDeliveries());
});

module.exports = router;
