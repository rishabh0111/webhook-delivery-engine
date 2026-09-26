'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const IORedis = require('ioredis');
const { QueueEvents } = require('bullmq');
const b = require('./lib');

// Idempotency benchmark. The engine has two separate dedup mechanisms and this
// exercises each on its own path:
//
//   A. Ingest idempotency — POST /api/events twice with the same
//      Idempotency-Key. Dedup is the UNIQUE(idempotency_key) constraint +
//      INSERT ... ON CONFLICT DO NOTHING (src/routes/events.js); the second
//      request never reaches the queue. Half the pairs are sent concurrently,
//      half back to back.
//   B. Duplicate enqueue — the same event id added to BullMQ twice at once via
//      enqueueDelivery (src/queue.js, jobId = event id). Events are inserted
//      the way the ingest route inserts them, then enqueued twice.
//   C. Late re-enqueue — each B event enqueued a third time after it was
//      delivered. removeOnComplete has dropped the first job, so jobId can't
//      dedup; this is the worker's status guard (src/worker.js).
//
// Double-sends are counted at the receiver.
//
//   node bench/idempotency.js --events 10000 --concurrency 32
async function main() {
  const args = b.parseArgs();
  const M = Number(args.events) || 10000;
  const concurrency = Number(args.concurrency) || 32;
  const waitMs = (Number(args['wait-min']) || 20) * 60 * 1000;

  const runDir = b.makeRunDir(`idempotency-${M}`);
  b.log(`run dir ${runDir}`);
  const engine = await b.startEngine(runDir);
  const receiver = await b.startReceiver(runDir);

  // --- A: HTTP ingest with duplicate Idempotency-Key ----------------------
  const subA = await b.createSubscription(receiver.url, `bench idempotency A ${M}`);
  const ingestLog = fs.createWriteStream(path.join(runDir, 'ingest-a.ndjson'));
  const tally = { concurrentPairs: 0, sequentialPairs: 0, status: {}, pairsWithDifferentIds: 0, pairsNotOne202: 0 };
  const acceptedA = new Set();
  let next = 0;
  async function laneA() {
    while (next < M) {
      const seq = next;
      next += 1;
      const key = `idem-${subA}-${seq}`;
      const body = JSON.stringify({ seq, run: 'idempotency-a' });
      let pair;
      if (seq % 2 === 0) {
        tally.concurrentPairs += 1;
        pair = await Promise.all([b.ingest(subA, key, body), b.ingest(subA, key, body)]);
      } else {
        tally.sequentialPairs += 1;
        pair = [await b.ingest(subA, key, body)];
        pair.push(await b.ingest(subA, key, body));
      }
      for (const r of pair) {
        ingestLog.write(`${JSON.stringify({ seq, ...r })}\n`);
        tally.status[r.status] = (tally.status[r.status] || 0) + 1;
      }
      if (pair[0].id !== pair[1].id) tally.pairsWithDifferentIds += 1;
      if (pair.filter((r) => r.status === 202).length !== 1) tally.pairsNotOne202 += 1;
      for (const r of pair) if (r.status === 202) acceptedA.add(r.id);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, laneA));
  b.log('A: ingest done', JSON.stringify(tally));
  const waitA = await b.waitForTerminal(subA, acceptedA.size, waitMs);
  const dbA = await b.pool.query(
    'SELECT COUNT(*)::int AS events, COUNT(DISTINCT idempotency_key)::int AS keys FROM event WHERE subscription_id = $1',
    [subA]
  );

  // --- B: the same event id enqueued twice, concurrently ------------------
  // Required lazily: src/queue opens its own Redis connection.
  const { queue, connection, enqueueDelivery } = require('../src/queue');
  const eventsConn = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const queueEvents = new QueueEvents('deliveries', { connection: eventsConn });
  await queueEvents.waitUntilReady();
  let duplicated = 0;
  queueEvents.on('duplicated', () => {
    duplicated += 1;
  });

  const subB = await b.createSubscription(receiver.url, `bench idempotency B ${M}`);
  const idsB = [];
  for (let i = 0; i < M; i += 1000) {
    const n = Math.min(1000, M - i);
    const { rows } = await b.pool.query(
      `INSERT INTO event (subscription_id, idempotency_key, raw_body, status)
       SELECT $1::uuid, 'idem-b-' || $1::text || '-' || g, convert_to('{"run":"idempotency-b"}', 'UTF8'), 'pending'
       FROM generate_series($2::int, $3::int) g
       RETURNING id`,
      [subB, i, i + n - 1]
    );
    for (const r of rows) idsB.push(r.id);
  }
  let enqueueCalls = 0;
  next = 0;
  async function laneB() {
    while (next < idsB.length) {
      const id = idsB[next];
      next += 1;
      await Promise.all([enqueueDelivery(id, 'bench-dup-1'), enqueueDelivery(id, 'bench-dup-2')]);
      enqueueCalls += 2;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, laneB));
  b.log(`B: ${enqueueCalls} enqueue calls for ${idsB.length} events`);
  const waitB = await b.waitForTerminal(subB, idsB.length, waitMs);
  await b.sleep(3000); // let the last 'duplicated' events arrive
  const duplicatedB = duplicated;

  // --- C: re-enqueue every delivered B event once more ---------------------
  await receiver.flush();
  const beforeC = b.readNdjson(receiver.file).length;
  const attemptsBeforeC = (await b.pool.query(
    'SELECT COUNT(*)::int AS n FROM delivery_attempt a JOIN event e ON e.id = a.event_id WHERE e.subscription_id = $1',
    [subB]
  )).rows[0].n;
  next = 0;
  async function laneC() {
    while (next < idsB.length) {
      const id = idsB[next];
      next += 1;
      await enqueueDelivery(id, 'bench-late');
    }
  }
  await Promise.all(Array.from({ length: concurrency }, laneC));
  // Wait for the late jobs to be consumed (they complete as no-ops).
  for (;;) {
    const c = await queue.getJobCounts('waiting', 'active', 'delayed');
    if (c.waiting + c.active + c.delayed === 0) break;
    await b.sleep(1000);
  }
  await b.sleep(3000);
  await receiver.flush();
  // One receiver serves both phases; split its log by which phase owns the id.
  const receipts = b.readNdjson(receiver.file);
  const setB = new Set(idsB);
  const receiptsA = receipts.filter((r) => !setB.has(r.id));
  const receiptsB = receipts.filter((r) => !acceptedA.has(r.id));
  const attemptsAfterC = (await b.pool.query(
    'SELECT COUNT(*)::int AS n FROM delivery_attempt a JOIN event e ON e.id = a.event_id WHERE e.subscription_id = $1',
    [subB]
  )).rows[0].n;

  const summary = {
    benchmark: 'idempotency',
    machine: b.machineInfo(),
    env: { LOG_LEVEL: process.env.LOG_LEVEL || '(default info)' },
    params: { M, concurrency },
    A_ingestIdempotencyKey: {
      subscriptionId: subA,
      requests: M * 2,
      ...tally,
      dbEvents: dbA.rows[0].events,
      dbDistinctKeys: dbA.rows[0].keys,
      allTerminal: waitA.done,
      finalDb: await b.statusCounts(subA),
      receiver: b.analyseReceipts(receiptsA, acceptedA),
    },
    B_duplicateEnqueueSameJobId: {
      subscriptionId: subB,
      events: idsB.length,
      enqueueCalls,
      bullmqDuplicatedEvents: duplicatedB,
      allTerminal: waitB.done,
      finalDb: await b.statusCounts(subB),
      receiverDeliveriesBeforeC: beforeC - receiptsA.length,
    },
    C_lateReenqueueAfterDelivery: {
      enqueueCalls: idsB.length,
      bullmqDuplicatedEvents: duplicated - duplicatedB,
      deliveryAttemptsBefore: attemptsBeforeC,
      deliveryAttemptsAfter: attemptsAfterC,
      receiverDeliveriesAfter: receiptsB.length,
    },
    receiverB: b.analyseReceipts(receiptsB, setB),
  };
  b.writeJson(runDir, 'summary.json', summary);
  console.log(JSON.stringify(summary, null, 2));

  await queueEvents.close();
  eventsConn.disconnect();
  await queue.close();
  connection.disconnect();
  await receiver.stop();
  await b.killEngine(engine);
  await b.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
