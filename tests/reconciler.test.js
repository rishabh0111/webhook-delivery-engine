'use strict';

const crypto = require('crypto');
const { reconcile } = require('../src/reconciler');
const { queue, enqueueDelivery } = require('../src/queue');
const { pool, setupDb, resetDb, teardownDb } = require('./helpers/db');
const { resetQueue, closeQueue } = require('./helpers/queue');

let subId;

beforeAll(async () => {
  await setupDb();
});

beforeEach(async () => {
  await resetDb();
  await resetQueue();
  const sub = await pool.query(
    "INSERT INTO subscription (target_url) VALUES ('https://example.com/hook') RETURNING id"
  );
  subId = sub.rows[0].id;
});

afterAll(async () => {
  await closeQueue();
  await teardownDb();
});

// Seed an event with an explicit age so it's unambiguously older than the
// reconciler's thresholds.
async function seedEvent(status, ageInterval = '1 hour') {
  const ev = await pool.query(
    `INSERT INTO event (subscription_id, idempotency_key, raw_body, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now() - $5::interval, now() - $5::interval)
     RETURNING id`,
    [subId, `rc-${crypto.randomUUID()}`, Buffer.from('{}', 'utf8'), status, ageInterval]
  );
  return ev.rows[0].id;
}

describe('reconcile (outbox backstop)', () => {
  it('re-enqueues stale pending and stale delivering events, leaves a queued event and terminal events alone', async () => {
    const stalePending = await seedEvent('pending');
    const staleDelivering = await seedEvent('delivering');
    const delivered = await seedEvent('delivered');
    const dead = await seedEvent('dead');

    // An already-queued event: stale by age, but it has a live waiting job.
    const queued = await seedEvent('pending');
    await enqueueDelivery(queued, 'pre-existing');

    const result = await reconcile();

    // The two orphans were re-enqueued; the already-queued event was skipped.
    expect(result.reEnqueued).toBe(2);

    expect(await queue.getJob(stalePending)).toBeDefined();
    expect(await queue.getJob(staleDelivering)).toBeDefined();

    // Already-queued event still has its single job (not duplicated/disturbed).
    expect(await queue.getJob(queued)).toBeDefined();

    // Terminal events are never enqueued.
    expect(await queue.getJob(delivered)).toBeUndefined();
    expect(await queue.getJob(dead)).toBeUndefined();
  });

  it('does not touch events younger than the threshold', async () => {
    // Fresh pending event (age ~0), default threshold is 60s.
    const fresh = await seedEvent('pending', '0 seconds');

    const result = await reconcile();

    expect(result.reEnqueued).toBe(0);
    expect(await queue.getJob(fresh)).toBeUndefined();
  });

  it('honors overridable age thresholds (treats fresh events as stale when asked)', async () => {
    const fresh = await seedEvent('pending', '0 seconds');

    const result = await reconcile({ pendingAgeMs: 0, deliveringAgeMs: 0 });

    expect(result.reEnqueued).toBe(1);
    expect(await queue.getJob(fresh)).toBeDefined();
  });
});
