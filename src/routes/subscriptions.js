'use strict';

const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { ApiError } = require('../errors');
const { validate } = require('../middleware/validate');

const router = express.Router();

// Creation input. The caller never supplies the secret — the server generates
// it. `generate_secret` (default true) lets a caller opt out of signing for a
// low-stakes endpoint, producing a NULL secret.
const createSchema = z
  .object({
    target_url: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), {
        message: 'target_url must be an http(s) URL',
      }),
    description: z.string().max(1000).optional(),
    generate_secret: z.boolean().optional().default(true),
  })
  .strict();

const idParamSchema = z.object({ id: z.string().uuid() });

// POST /api/subscriptions — create a destination.
// Generates a randomBytes(32) hex secret (unless opted out) and returns it
// exactly once, inline in this response. It is never exposed again.
router.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const { target_url, description, generate_secret } = req.body;
    const secret = generate_secret
      ? crypto.randomBytes(32).toString('hex')
      : null;

    const { rows } = await db.query(
      `INSERT INTO subscription (target_url, secret, description)
       VALUES ($1, $2, $3)
       RETURNING id, target_url, description, secret, created_at`,
      [target_url, secret, description ?? null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/subscriptions — list destinations. The secret is never re-exposed;
// `has_secret` tells the operator whether signing is enabled.
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, target_url, description, (secret IS NOT NULL) AS has_secret, created_at
       FROM subscription
       ORDER BY created_at DESC`
    );
    res.status(200).json(rows);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/subscriptions/:id — remove a destination.
router.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  async (req, res, next) => {
    try {
      const { rowCount } = await db.query(
        'DELETE FROM subscription WHERE id = $1',
        [req.params.id]
      );
      if (rowCount === 0) {
        throw new ApiError(404, 'Subscription not found');
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;