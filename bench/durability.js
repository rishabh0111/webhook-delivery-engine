'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const b = require('./lib');

// Durability benchmark: ingest N events under sustained load, wipe Redis with
// FLUSHALL part-way through, then wait for every accepted event to reach a
// terminal state. Losses and double-sends are counted at the receiver, not
// taken from the engine's own bookkeeping.
//
//   node bench/durability.js --events 50000 --concurrency 32 --flush-at 0.5 \
//     --wait-min 20 [--restart-after-flush]
//
// --flush-at            fraction of N accepted before FLUSHALL is sent
// --wait-min            how long to wait for all events to go terminal
// --restart-after-flush hard-kill and restart the engine right after the
//                       flush (a restart re-registers the reconciler, which
//                       FLUSHALL otherwise deletes — see docs/results)
//
// BENCH_FLUSH_CMD overrides how the flush is sent, e.g.
//   BENCH_FLUSH_CMD="docker exec wde-bench-redis-1 redis-cli FLUSHALL"
// Otherwise FLUSHALL is sent over ioredis (the same Redis command).
async function main() {
  const args = b.parseArgs();
  const N = Number(args.events) || 50000;
  const concurrency = Number(args.concurrency) || 32;
  const flushAt = Math.floor(N * (Number(args['flush-at']) || 0.5));
  const waitMs = (Number(args['wait-min']) || 20) * 60 * 1000;
  const restart = Boolean(args['restart-after-flush']);

  const runDir = b.makeRunDir(`durability-${N}${restart ? '-restart' : ''}`);
  b.log(`run dir ${runDir}`);
  const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379');
  const queue = new Queue('deliveries', { connection: redis });

  let engine = await b.startEngine(runDir);
  const receiver = await b.startReceiver(runDir);
  const subId = await b.createSubscription(receiver.url, `bench durability ${N}`);

  const ingestLog = fs.createWriteStream(path.join(runDir, 'ingest.ndjson'));
  const accepted = new Set();
  const statusTally = {};
  let next = 0;
  let flush = null;
  const startedAt = Date.now();

  async function doFlush() {
    const before = {
      accepted: accepted.size,
      queue: await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed'),
      db: await b.statusCounts(subId),
      redisKeys: await redis.dbsize(),
    };
    const at = Date.now();
    if (process.env.BENCH_FLUSH_CMD) {
      execSync(process.env.BENCH_FLUSH_CMD, { stdio: 'inherit' });
    } else {
      await redis.flushall();
    }
    b.log(`FLUSHALL sent after ${before.accepted} accepted; queue before:`, JSON.stringify(before.queue));
    flush = { at, method: process.env.BENCH_FLUSH_CMD || 'ioredis FLUSHALL', before };
    if (restart) {
      await b.killEngine(engine);
      engine = await b.startEngine(runDir);
      flush.restartedAt = Date.now();
    }
  }

  // Closed-loop load: `concurrency` requests in flight, back to back. The
  // flush is triggered by whichever request pushes accepted past flushAt;
  // other lanes keep sending while it runs (that's the "mid-load" part).
  let flushing = null;
  async function lane() {
    while (next < N) {
      // While the engine restarts, hold the load rather than burn sequence
      // numbers on connection errors.
      if (restart && flushing) await flushing;
      const seq = next;
      next += 1;
      const key = `dur-${subId}-${seq}`;
      const body = JSON.stringify({ seq, run: 'durability', pad: crypto.randomBytes(24).toString('hex') });
      const r = await b.ingest(subId, key, body);
      ingestLog.write(`${JSON.stringify(r)}\n`);
      statusTally[r.status] = (statusTally[r.status] || 0) + 1;
      if (r.status === 202) accepted.add(r.id);
      if (!flushing && accepted.size >= flushAt) flushing = doFlush();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, lane));
  if (flushing) await flushing;
  const ingestDoneAt = Date.now();
  b.log(`ingest done: ${accepted.size} accepted of ${N} in ${(ingestDoneAt - startedAt) / 1000}s`, statusTally);

  b.log(`waiting up to ${waitMs / 60000} min for all events to be terminal`);
  const wait = await b.waitForTerminal(subId, accepted.size, waitMs, 10000);
  const finishedAt = Date.now();

  // A short grace period so any late duplicate send still lands in the log.
  await b.sleep(5000);
  await receiver.flush();
  const receipts = b.readNdjson(receiver.file);
  const result = b.analyseReceipts(receipts, accepted);
  const finalDb = await b.statusCounts(subId);

  const summary = {
    benchmark: 'durability',
    machine: b.machineInfo(),
    env: {
      RECONCILE_INTERVAL_MS: process.env.RECONCILE_INTERVAL_MS || '(default 900000)',
      RECONCILE_PENDING_AGE_MS: process.env.RECONCILE_PENDING_AGE_MS || '(default 60000)',
      RECONCILE_DELIVERING_AGE_MS: process.env.RECONCILE_DELIVERING_AGE_MS || '(default 300000)',
      LOG_LEVEL: process.env.LOG_LEVEL || '(default info)',
    },
    params: { N, concurrency, flushAt, waitMin: waitMs / 60000, restartAfterFlush: restart },
    subscriptionId: subId,
    ingest: {
      statusTally,
      accepted: accepted.size,
      seconds: (ingestDoneAt - startedAt) / 1000,
      acceptedPerMin: Math.floor((accepted.size / (ingestDoneAt - startedAt)) * 60000),
    },
    flush,
    allTerminal: wait.done,
    secondsFromIngestEndToTerminal: wait.done ? (finishedAt - ingestDoneAt) / 1000 : null,
    finalDb,
    receiver: result,
  };
  b.writeJson(runDir, 'summary.json', summary);
  b.writeJson(runDir, 'db-samples.json', wait.samples);
  console.log(JSON.stringify(summary, null, 2));

  await receiver.stop();
  await b.killEngine(engine);
  await queue.close();
  redis.disconnect();
  await b.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
