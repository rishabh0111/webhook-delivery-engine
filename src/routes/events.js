'use strict';

const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { ApiError } = require('../errors');
const { enqueueDelivery } = require('../queue');
const { signatureHeader, HEADER_SIGNATURE } = require('../signing');

const router = express.Router();
const uuidSchema = z.string().uuid();

// Render an event row for API responses. raw_body (bytea) is surfaced as a
// UTF-8 `payload` string for convenience.
function serializeEvent(row) {
  return {
    id: row.id,
    subscription_id: row.subscription_id,
    idempotency_key: row.idempotency_key,
    status: row.status,
    payload: row.raw_body ? row.raw_body.toString('utf8') : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// POST /api/events — ingest an event (the outbox pattern).
// Routing/idempotency metadata travel in headers so the body can be the exact
// payload bytes (express.raw is mounted for this router in app.js):
//   X-Subscription-Id : required, the target subscription
//   Idempotency-Key   : optional, caller-supplied dedup key (UUID fallback)
router.post('/', async (req, res, next) => {
  try {
    const subscriptionId = req.get('x-subscription-id');
    if (!uuidSchema.safeParse(subscriptionId).success) {
      throw new ApiError(400, 'X-Subscription-Id header is required and must be a UUID');
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new ApiError(400, 'Request body (the event payload) must not be empty');
    }

    const sub = await db.query('SELECT id FROM subscription WHERE id = $1', [subscriptionId]);
    if (sub.rowCount === 0) {
      throw new ApiError(404, 'Subscription not found');
    }

    const idempotencyKey = req.get('idempotency-key') || crypto.randomUUID();
    const correlationId = String(req.id || crypto.randomUUID());

    // ON CONFLICT DO NOTHING distinguishes a fresh key (row returned) from a
    // replayed one (no row) without a second round-trip on the happy path.
    const inserted = await db.query(
      `INSERT INTO event (subscription_id, idempotency_key, raw_body, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [subscriptionId, idempotencyKey, req.body]
    );

    if (inserted.rowCount === 0) {
      const existing = await db.query('SELECT * FROM event WHERE idempotency_key = $1', [idempotencyKey]);
      return res.status(200).json(serializeEvent(existing.rows[0]));
    }

    const event = inserted.rows[0];

    // Enqueue after the commit. A failure here is non-fatal by design.
    try {
      await enqueueDelivery(event.id, correlationId);
    } catch (err) {
      req.log.error({ err, eventId: event.id }, 'enqueue failed; reconciler will recover');
    }

    return res.status(202).json(serializeEvent(event));
  } catch (err) {
    return next(err);
  }
});

// GET /api/events/:id/signature — the signing headers a receiver should expect
// for this event, computed from the subscription's stored secret over the exact
// raw_body bytes. The timestamp (and thus the signature) is freshly computed per
// call — a verification sample, not a record of a past delivery.
router.get('/:id/signature', async (req, res, next) => {
  try {
    if (!uuidSchema.safeParse(req.params.id).success) {
      throw new ApiError(400, 'id must be a UUID');
    }

    const { rows } = await db.query('SELECT * FROM event WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      throw new ApiError(404, 'Event not found');
    }
    const event = rows[0];

    const { rows: subRows } = await db.query('SELECT secret FROM subscription WHERE id = $1', [event.subscription_id]);
    const secret = subRows[0] ? subRows[0].secret : null;

    if (!secret) {
      return res.status(200).json({ event_id: event.id, signed: false });
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    res.status(200).json({
      event_id: event.id,
      signed: true,
      header: HEADER_SIGNATURE,
      timestamp,
      signature: signatureHeader(secret, timestamp, event.raw_body),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/events/:id — the event plus its attempt timeline.
router.get('/:id', async (req, res, next) => {
  try {
    if (!uuidSchema.safeParse(req.params.id).success) {
      throw new ApiError(400, 'id must be a UUID');
    }

    const { rows } = await db.query('SELECT * FROM event WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      throw new ApiError(404, 'Event not found');
    }

    const attempts = await db.query(
      `SELECT attempt_number, status_code, duration_ms, response_body, error, created_at
       FROM delivery_attempt
       WHERE event_id = $1
       ORDER BY attempt_number`,
      [req.params.id]
    );

    res.status(200).json({ ...serializeEvent(rows[0]), attempts: attempts.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;