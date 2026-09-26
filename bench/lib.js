'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork, spawn } = require('child_process');
const { Pool } = require('pg');

// Shared plumbing for the three benchmarks: start the engine and the receiver
// as child processes, ingest through the real HTTP API, and read authoritative
// state straight from Postgres. Nothing here changes engine behaviour — the
// engine runs as `node src/index.js` with whatever env the caller exported.

const ROOT = path.join(__dirname, '..');
const ENGINE_PORT = Number(process.env.PORT) || 3000;
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;
const RECEIVER_PORT = Number(process.env.BENCH_RECEIVER_PORT) || 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse `--name value` / `--flag` arguments into an object.
function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

// Each run writes into its own directory: the receiver's NDJSON, the ingest
// log, the engine's stdout, and summary.json.
function makeRunDir(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROOT, 'bench', 'out', `${stamp}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

function machineInfo() {
  return {
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    memGb: Math.round(os.totalmem() / 1e9),
    platform: `${os.type()} ${os.release()}`,
    node: process.version,
  };
}

// --- child processes ------------------------------------------------------

// Children still running when the bench exits (including on a crash) are
// killed, so a failed run never leaves an engine holding the port.
const children = new Set();
process.on('exit', () => {
  for (const c of children) c.kill('SIGKILL');
});
function track(child) {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// Start the engine (API + worker + reconciler, one process) with its stdout
// appended to engine.log in the run directory.
async function startEngine(runDir) {
  const logStream = fs.openSync(path.join(runDir, 'engine.log'), 'a');
  const child = track(
    spawn(process.execPath, ['src/index.js'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', logStream, logStream],
    })
  );
  await waitForHttp(`${ENGINE_URL}/health`);
  log(`engine up (pid ${child.pid})`);
  return child;
}

// Hard-kill, like a crashed or redeployed instance (on Windows every signal
// is a hard kill anyway).
async function killEngine(child) {
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  log(`engine killed (pid ${child.pid})`);
}

async function startReceiver(runDir) {
  const file = path.join(runDir, 'receiver.ndjson');
  const child = track(fork(path.join(__dirname, 'receiver.js'), [file, String(RECEIVER_PORT)]));
  await new Promise((resolve, reject) => {
    child.once('message', (m) => (m.ready ? resolve() : reject(new Error('receiver failed'))));
    child.once('exit', (code) => reject(new Error(`receiver exited ${code}`)));
  });
  return {
    file,
    url: `http://127.0.0.1:${RECEIVER_PORT}/hook`,
    // Flush pending writes and return how many deliveries it has answered.
    async flush() {
      child.send({ cmd: 'flush' });
      return new Promise((r) => child.once('message', (m) => r(m.received)));
    },
    async stop() {
      const exited = new Promise((r) => child.once('exit', r));
      child.send({ cmd: 'stop' });
      await exited;
    },
  };
}

// --- engine API -----------------------------------------------------------

async function createSubscription(targetUrl, description) {
  const res = await fetch(`${ENGINE_URL}/api/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_url: targetUrl, description }),
  });
  if (res.status !== 201) throw new Error(`create subscription: ${res.status}`);
  return (await res.json()).id;
}

// One POST /api/events. Never throws: a network error is returned as
// status 0 so the caller can count it rather than abort the run.
async function ingest(subscriptionId, idempotencyKey, body) {
  const sentAt = Date.now();
  try {
    const res = await fetch(`${ENGINE_URL}/api/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-subscription-id': subscriptionId,
        'idempotency-key': idempotencyKey,
      },
      body,
    });
    const json = await res.json().catch(() => ({}));
    return { key: idempotencyKey, status: res.status, id: json.id || null, sentAt, ackAt: Date.now() };
  } catch (err) {
    return { key: idempotencyKey, status: 0, id: null, sentAt, ackAt: Date.now(), error: String(err.message || err) };
  }
}

// --- Postgres (authoritative state) ---------------------------------------

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

async function statusCounts(subscriptionId) {
  const { rows } = await pool.query(
    'SELECT status, COUNT(*)::int AS n FROM event WHERE subscription_id = $1 GROUP BY status',
    [subscriptionId]
  );
  const counts = { pending: 0, delivering: 0, delivered: 0, failed: 0, dead: 0 };
  for (const r of rows) counts[r.status] = r.n;
  counts.total = rows.reduce((s, r) => s + r.n, 0);
  counts.nonTerminal = counts.pending + counts.delivering + counts.failed;
  return counts;
}

// Poll until every event for the subscription is terminal (delivered | dead),
// or give up after timeoutMs. Returns the samples taken along the way.
async function waitForTerminal(subscriptionId, expected, timeoutMs, everyMs = 5000) {
  const samples = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = await statusCounts(subscriptionId);
    samples.push({ t: Date.now(), ...c });
    log(`  db: total=${c.total} delivered=${c.delivered} dead=${c.dead} pending=${c.pending} delivering=${c.delivering}`);
    if (c.total >= expected && c.nonTerminal === 0) return { done: true, samples };
    if (Date.now() >= deadline) return { done: false, samples };
    await sleep(everyMs);
  }
}

// --- analysis -------------------------------------------------------------

function readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// Receiver-side counts against the set of event ids the API accepted.
function analyseReceipts(receipts, acceptedIds) {
  const perId = new Map();
  for (const r of receipts) perId.set(r.id, (perId.get(r.id) || 0) + 1);
  let missing = 0;
  let duplicateSends = 0;
  let idsWithDuplicates = 0;
  const missingIds = [];
  for (const id of acceptedIds) {
    const n = perId.get(id) || 0;
    if (n === 0) {
      missing += 1;
      if (missingIds.length < 20) missingIds.push(id);
    }
    if (n > 1) {
      idsWithDuplicates += 1;
      duplicateSends += n - 1;
    }
  }
  let unexpected = 0;
  for (const id of perId.keys()) if (!acceptedIds.has(id)) unexpected += 1;
  return {
    accepted: acceptedIds.size,
    receipts: receipts.length,
    uniqueReceived: perId.size,
    missing,
    missingIdsSample: missingIds,
    idsWithDuplicates,
    duplicateSends,
    unexpectedIds: unexpected,
  };
}

// Nearest-rank percentile over a sorted array (no interpolation).
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function writeJson(runDir, name, data) {
  fs.writeFileSync(path.join(runDir, name), `${JSON.stringify(data, null, 2)}\n`);
}

module.exports = {
  ROOT,
  ENGINE_URL,
  sleep,
  parseArgs,
  makeRunDir,
  log,
  machineInfo,
  startEngine,
  killEngine,
  startReceiver,
  createSubscription,
  ingest,
  pool,
  statusCounts,
  waitForTerminal,
  readNdjson,
  analyseReceipts,
  percentile,
  writeJson,
};
