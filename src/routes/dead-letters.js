'use strict';

const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { ApiError } = require('../errors');
const { queue, enqueueDelivery } = require('../queue');

const router = express.Router();
const uuidSchema = z.string().uuid();

// POST /api/dead-letters/:id/replay
//
// :id is the dead_letter row id. Steps (order matters):
//   1. Atomic dead->pending flip on the event, guarded on current status.
//      If not dead -> 409 so a double-click can't double-deliver.
//   2. Remove the stale failed BullMQ job (jobId = event.id). Required because
//      queue.add with an existing jobId silently no-ops.
//   3. Re-enqueue (jobId = event.id).
//   4. Stamp dead_letter.replayed_at. Kept after enqueue so a crash between
//      enqueue and this stamp is safe — the reconciler picks up the pending event.
router.post('/:id/replay', async (req, res, next) => {
  try {
    if (!uuidSchema.safeParse(req.params.id).success) {
      throw new ApiError(400, 'id must be a UUID');
    }

    const { rows: dlRows } = await db.query('SELECT * FROM dead_letter WHERE id = $1', [req.params.id]);
    if (dlRows.length === 0) {
      throw new ApiError(404, 'Dead letter not found');
    }
    const deadLetter = dlRows[0];
    const eventId = deadLetter.event_id;

    const { rowCount } = await db.query(
      `UPDATE event SET status = 'pending', updated_at = now()
       WHERE id = $1 AND status = 'dead'`,
      [eventId]
    );
    if (rowCount === 0) {
      throw new ApiError(409, 'Event is not currently dead; replay is not allowed');
    }

    // Remove stale job before re-adding — a same-jobId add would be a no-op.
    try {
      const job = await queue.getJob(eventId);
      if (job) {
        await job.remove();
      }
    } catch (err) {
      req.log.warn({ err, eventId }, 'failed to remove stale job before replay re-enqueue');
    }

    try {
      await enqueueDelivery(eventId, 'replay');
    } catch (err) {
      req.log.error({ err, eventId }, 'replay enqueue failed; reconciler will recover');
    }

    await db.query('UPDATE dead_letter SET replayed_at = now() WHERE id = $1', [deadLetter.id]);

    res.status(200).json({ event_id: eventId, status: 'pending' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;