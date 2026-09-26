'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const b = require('./lib');

// Throughput + latency benchmark: an open-loop generator sends events at a
// fixed rate for a fixed duration, whether or not earlier requests have
// returned (so a slow engine can't quietly lower the offered load). Latency is
// end to end: from just before the ingest request is sent to the moment the
// receiver sends its 2xx for that event id.
//
//   node bench/throughput.js --rate 5000 --minutes 15
//
// Every 10s it samples the backlog: accepted events not yet delivered
// (Postgres) and the BullMQ job counts.
async function main() {
  const args = b.parseArgs();
  const ratePerMin = Number(args.rate) || 5000;
  const minutes = Number(args.minutes) || 15;
  const drainMs = (Number(args['drain-min']) || 10) * 60 * 1000;
  const total = Math.floor(ratePerMin * minutes);
  const intervalMs = 60000 / ratePerMin;

  const runDir = b.makeRunDir(`throughput-${ratePerMin}pm-${minutes}m`);
  b.log(`run dir ${runDir}`);
  const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue('deliveries', { connection: redis });

  const engine = await b.startEngine(runDir);
  const receiver = await b.startReceiver(runDir);
  const subId = await b.createSubscription(receiver.url, `bench throughput ${ratePerMin}/min`);

  const ingestLog = fs.createWriteStream(path.join(runDir, 'ingest.ndjson'));
  const results = [];
  const inFlight = new Set();
  const samples = [];
  let sent = 0;
  let maxInFlight = 0;
  let maxLagMs = 0;

  async function sample() {
    const [db, q, delivered] = await Promise.all([
      b.statusCounts(subId),
      queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      receiver.flush(),
    ]);
    const s = {
      t: Date.now(),
      sent,
      acked: results.length,
      inFlight: inFlight.size,
      receiverDeliveries: delivered,
      dbTotal: db.total,
      dbDelivered: db.delivered,
      dbDead: db.dead,
      backlog: db.total - db.delivered - db.dead,
      queue: q,
    };
    samples.push(s);
    b.log(`  sent=${s.sent} acked=${s.acked} delivered=${s.dbDelivered} backlog=${s.backlog} waiting=${q.waiting} active=${q.active} inFlight=${s.inFlight}`);
  }

  // Scheduler: event i is due at start + i*interval. Each 5ms tick sends
  // every event that has come due, so timer jitter delays sends a little but
  // never drops them; lag behind schedule is recorded.
  const start = Date.now();
  const sampler = setInterval(() => sample().catch((e) => b.log('sample failed', e.message)), 10000);
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      const now = Date.now();
      while (sent < total && start + sent * intervalMs <= now) {
        const seq = sent;
        sent += 1;
        maxLagMs = Math.max(maxLagMs, now - (start + seq * intervalMs));
        const body = JSON.stringify({ seq, run: 'throughput', pad: crypto.randomBytes(24).toString('hex') });
        const p = b.ingest(subId, `tp-${subId}-${seq}`, body).then((r) => {
          inFlight.delete(p);
          results.push(r);
          ingestLog.write(`${JSON.stringify(r)}\n`);
        });
        inFlight.add(p);
        maxInFlight = Math.max(maxInFlight, inFlight.size);
      }
      if (sent >= total) {
        clearInterval(tick);
        resolve();
      }
    }, 5);
  });
  const sendEndAt = Date.now();
  await Promise.all(inFlight);
  const ackEndAt = Date.now();
  await sample();
  clearInterval(sampler);
  b.log(`load phase done: ${sent} sent in ${(sendEndAt - start) / 1000}s`);

  // Drain: whatever backlog is left at the end of the load phase.
  const accepted = new Set(results.filter((r) => r.status === 202).map((r) => r.id));
  const wait = await b.waitForTerminal(subId, accepted.size, drainMs, 2000);
  const drainedAt = Date.now();
  await b.sleep(2000);
  await receiver.flush();

  // Join ingest send time to the receiver's first 2xx for each event id.
  const receipts = b.readNdjson(receiver.file);
  const firstReceipt = new Map();
  for (const r of receipts) if (!firstReceipt.has(r.id)) firstReceipt.set(r.id, r.t);
  // Also bucketed by the minute the event was sent, so a stall shows up as a
  // bad minute instead of disappearing into the overall tail.
  const lat = [];
  const byMinute = [];
  for (const r of results) {
    if (r.status !== 202) continue;
    const t = firstReceipt.get(r.id);
    if (t === undefined) continue;
    lat.push(t - r.sentAt);
    const m = Math.floor((r.sentAt - start) / 60000);
    (byMinute[m] = byMinute[m] || []).push(t - r.sentAt);
  }
  lat.sort((x, y) => x - y);
  const ackLat = results.filter((r) => r.status === 202).map((r) => r.ackAt - r.sentAt).sort((x, y) => x - y);
  const pct = (arr) => ({
    n: arr.length,
    p50: b.percentile(arr, 50),
    p95: b.percentile(arr, 95),
    p99: b.percentile(arr, 99),
    max: arr.length ? arr[arr.length - 1] : null,
  });

  const statusTally = {};
  for (const r of results) statusTally[r.status] = (statusTally[r.status] || 0) + 1;
  // Only this run's events: a stale event from an earlier run that the
  // reconciler re-enqueues would otherwise inflate the delivered rate.
  const deliveredDuringLoad = receipts.filter((r) => r.t <= sendEndAt && accepted.has(r.id)).length;
  const loadSeconds = (sendEndAt - start) / 1000;

  const summary = {
    benchmark: 'throughput',
    machine: b.machineInfo(),
    env: { LOG_LEVEL: process.env.LOG_LEVEL || '(default info)' },
    params: { ratePerMin, minutes, total, drainMin: drainMs / 60000 },
    subscriptionId: subId,
    generator: { sent, loadSeconds, maxLagBehindScheduleMs: maxLagMs, maxInFlight, secondsToLastAck: (ackEndAt - start) / 1000 },
    ingest: {
      statusTally,
      accepted: accepted.size,
      offeredPerMin: Math.floor((sent / (sendEndAt - start)) * 60000),
      ackLatencyMs: pct(ackLat),
    },
    delivery: {
      deliveredDuringLoadWindow: deliveredDuringLoad,
      deliveredPerMinDuringLoad: Math.floor((deliveredDuringLoad / (sendEndAt - start)) * 60000),
      backlogAtEndOfLoad: samples[samples.length - 1].backlog,
      maxBacklogSampled: Math.max(...samples.map((s) => s.backlog)),
      allTerminal: wait.done,
      secondsFromLoadEndToDrained: wait.done ? (drainedAt - sendEndAt) / 1000 : null,
    },
    endToEndLatencyMs: pct(lat),
    endToEndLatencyMsBySendMinute: byMinute.map((a) => pct(a.sort((x, y) => x - y))),
    receiver: b.analyseReceipts(receipts, accepted),
  };
  b.writeJson(runDir, 'summary.json', summary);
  b.writeJson(runDir, 'backlog-samples.json', samples);
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
