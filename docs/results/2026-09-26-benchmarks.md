# Benchmarks — 26 Sep 2026

Three benchmarks from [bench/](../../bench/), run against the engine at commit
`3feeb20` with no changes to `src/`, except D3, which ran after the fix for
the bug D2 found (see "Bug: FLUSHALL deletes the reconciler's own schedule"). Every run is listed below, including the
smoke tests and the failed ones. Each run's `summary.json` (plus backlog / DB
samples and console output) is in [2026-09-26/](2026-09-26/), one directory
per run; the raw NDJSON (every ingest request, every receiver hit) and engine
logs stayed in `bench/out/` and are not committed (about 400 MB).

## Headline

| Benchmark | Result |
| --- | --- |
| Durability, FLUSHALL mid-load, **no restart, after the fix** (D3) | **0 of 50,000** lost, 0 double-sends, no restart. All 50,000 delivered 191.091 s after ingest ended; the watchdog noticed the lost schedule 24 s after the flush and swept at once. |
| Durability, FLUSHALL mid-load, **no restart, before the fix** (D2) | **23,536 of 50,000** accepted events never delivered. The reconciler never ran again after the flush (bug, below). |
| Durability, FLUSHALL mid-load, **engine restarted after the flush** | **0 of 50,000** lost, 0 double-sends. All 50,000 delivered 722.492 s after ingest ended; one reconciler sweep re-enqueued 23,419 events. |
| Throughput, 5,000 events/min for 15 min (clean runs 2 and 3) | 75,000 / 75,000 delivered in each run. End-to-end p50 / p95 / p99 / max: **25 / 47 / 139 / 418 ms** (run 2) and **23 / 33 / 38 / 170 ms** (run 3). Backlog stayed flat (max sampled 9 and 4). |
| Idempotency, 10,000 events × 2 | Ingest key: 20,000 requests → 10,000 events → 10,000 deliveries, 0 double-sends. Same event id enqueued twice: 20,000 enqueues → 10,000 jobs (BullMQ reported 10,000 duplicates) → 10,000 deliveries, 0 double-sends. |

## Machine and setup

- Laptop: 12th Gen Intel Core i5-1245U (12 logical CPUs), 16 GB RAM
  (`os.totalmem()` rounds to 17 GB), Windows 11 Pro 10.0.26200, Node v24.19.0.
- Docker Desktop 29.7.2, VM with 12 CPUs / 8 GB, running `docker-compose.yml`
  as project `wde-bench`: `postgres:16-alpine`, `redis:7-alpine` with
  `maxmemory-policy noeviction`. Other, unrelated containers were running in
  the same Docker VM during all runs (mostly idle).
- BullMQ 5.79.3. Engine as shipped: one process (API + worker + reconciler),
  worker `concurrency: 5`, default `LOG_LEVEL=info` written to a file,
  `NODE_ENV` unset (so demo routes are mounted; not used).
- The receiver ([bench/receiver.js](../../bench/receiver.js)) is a separate
  Node process on `127.0.0.1:4000` that answers every POST with `200` and logs
  `{ id: X-Webhook-Id, t: Date.now() }` after sending the response.
- Latency is `receiver t − sentAt`, where `sentAt` is `Date.now()` just before
  the ingest `fetch`. Both clocks are the same machine's wall clock.
  Percentiles are nearest-rank over every event (no sampling, no
  interpolation). The first receipt per event id is used; there were no
  second receipts in any run.

Environment for every run:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/webhooks
export REDIS_URL=redis://localhost:6379
```

## Caveats

- Everything is on one laptop: load generator, engine, receiver, Postgres and
  Redis share the same CPUs. Network hops are loopback (and Docker's port
  forwarding for Postgres and Redis). Real receivers add real network latency.
- Single engine instance, worker concurrency 5. The receiver does no work.
- Payloads are small (about 90 bytes). Subscriptions have signing secrets, so
  every delivery is HMAC-signed.
- Throughput was measured at exactly one offered rate (5,000/min). It held, so
  the maximum sustainable rate was not searched for. The only higher-rate
  evidence is incidental: in the idempotency run the worker drained a 10,000
  event backlog in about 40 s; that was not a sustained-rate test.

## Runs

| # | Run directory | Command | Outcome |
| --- | --- | --- | --- |
| S1 | `07-08-58-480Z-idempotency-200` | `node bench/idempotency.js --events 200` | **Failed** (harness bug: a Postgres parameter-type error in phase B's insert). Phase A had completed. No summary. Fixed the SQL in the harness. |
| S2 | `07-09-17-872Z-idempotency-200` | same | Smoke test, clean: 0 double-sends on all phases. |
| S3 | `07-09-46-790Z-throughput-3000pm-0.5m` | `node bench/throughput.js --rate 3000 --minutes 0.5` | Smoke test. 1,500 / 1,500 delivered. |
| S4 | `07-10-29-952Z-durability-3000` | `RECONCILE_INTERVAL_MS=60000 BENCH_FLUSH_CMD="docker exec wde-bench-redis-1 redis-cli FLUSHALL" node bench/durability.js --events 3000 --wait-min 3` | Smoke test. 1,435 of 3,000 stranded in `pending`; first sign of the reconciler bug. These 1,435 were later delivered during T1 (below). |
| T1 | `07-14-02-212Z-throughput-5000pm-15m` | `node bench/throughput.js --rate 5000 --minutes 15` | **Contaminated, not used for the headline.** When T1's engine booted, it re-registered the reconciler, which at 07:15:07 re-enqueued S4's 1,435 stranded events; they were delivered to the same receiver port in seconds 57–69 of the run. T1 also had latency spikes in minutes 3 and 10 that the contamination doesn't explain. |
| T2 | `07-29-50-377Z-throughput-5000pm-15m` | same | Clean. |
| T3 | `07-45-18-433Z-throughput-5000pm-15m` | same | Clean. |
| I1 | `08-00-39-025Z-idempotency-10000` | `node bench/idempotency.js --events 10000` | Clean. |
| D1 | `08-03-05-938Z-durability-50000-restart` | `BENCH_FLUSH_CMD="docker exec wde-bench-redis-1 redis-cli FLUSHALL" node bench/durability.js --events 50000 --wait-min 40 --restart-after-flush` | 0 lost, needed a restart. |
| D2 | `08-16-58-321Z-durability-50000` | `RECONCILE_INTERVAL_MS=60000 BENCH_FLUSH_CMD="docker exec wde-bench-redis-1 redis-cli FLUSHALL" node bench/durability.js --events 50000 --wait-min 10` | 23,536 lost (never delivered within the wait). |
| D3 | `08-35-33-649Z-durability-50000` | `node bench/durability.js --events 50000 --wait-min 20` (after the fix; all defaults) | 0 lost, 0 double-sends, no restart. |

T1 and T2 ran before `throughput.js` gained its per-minute breakdown and its
rule that only the run's own events count toward "delivered during load".
Their `latency-by-send-minute.json` files were computed afterwards from the
raw NDJSON with the same logic.

## 1. Durability — FLUSHALL mid-load

`durability.js` ingests N events with 32 requests in flight, runs
`redis-cli FLUSHALL` (via `docker exec`) as soon as N/2 have been accepted
while the other lanes keep sending, then polls Postgres every 10 s until every
accepted event is `delivered` or `dead`. Losses and double-sends are counted
at the receiver against the set of event ids that got a `202`.

Ingest outruns the worker (about 34,000–43,000 accepted/min vs about 5 jobs in
flight), so a large queue is standing when the flush lands. That is the point:
the flush has to destroy real queued work.

### D2: no restart (engine as shipped, reconciler every 60 s)

| | |
| --- | --- |
| Accepted (`202`) | 50,000 of 50,000 in 70.137 s |
| Queue at the flush | 23,465 waiting, 5 active (23,584 Redis keys) |
| After 10 min | delivered 26,464, **pending 23,536**, dead 0 |
| Receiver | 26,464 unique, **23,536 missing**, 0 duplicates |
| Reconciler sweeps logged after the flush | 0 |

`RECONCILE_INTERVAL_MS=60000` (instead of the default 15 min) was set to give
the reconciler 10 chances inside the wait. It took none.

### D1: engine hard-killed and restarted right after the flush (defaults)

| | |
| --- | --- |
| Accepted (`202`) | 50,000 of 50,000 in 87.737 s (load paused about 1 s for the restart) |
| Queue at the flush | 23,468 waiting, 5 active (23,505 Redis keys) |
| Stuck (DB samples 08:06:35 → 08:14:35) | 23,419 `pending`, unchanged |
| Reconciler sweep, logged on completion at 08:16:17 | `scanned: 23419, reEnqueued: 23419` |
| All terminal | 722.492 s after ingest ended: 50,000 delivered, 0 dead |
| Receiver | 50,000 unique, **0 missing, 0 duplicates**, 0 unexpected |

The wait is set by the reconciler's schedule (default 15 min interval), not
by the drain. The sweep re-enqueues one event at a time, so the worker was
already delivering while it ran: the 08:15:36 sample shows 35,196 delivered,
and by 08:16:36 all 50,000 were.

### Bug: FLUSHALL deletes the reconciler's own schedule

The reconciler is a BullMQ repeatable job, which lives in Redis. It is
registered only once, at boot:

- `src/index.js:17-19` calls `scheduleReconciler(reconciler.queue)` in
  `start()`.
- `src/reconciler.js:90-97` adds it as `queue.add(RECONCILE_JOB, {}, { repeat: { every } })`.

`FLUSHALL` deletes the repeat key and the next scheduled job along with the
delivery queue, and nothing re-registers them while the process keeps
running. Reproduced directly: with `RECONCILE_INTERVAL_MS=5000`, the
`bull:maintenance:*` keys were present before the flush; 12 s after it, and
again on a later check, Redis had no keys at all, so no sweep was scheduled. D2 and S4 show the effect under
load. So the README's "Losing Redis entirely loses no events — the reconciler
rebuilds the work queue from Postgres" (README.md:56-58) holds only once the
process restarts. Nothing is lost from Postgres (every stranded event is
still `pending` there, and a restart recovers all of them, as D1 and T1 show),
but without a restart, delivery stops for those events.

**Fixed after these runs.** The process now runs a watchdog every
`RECONCILE_WATCHDOG_MS` (default 60 s) that asks Redis whether the
reconciler's schedule still exists (`getJobSchedulersCount`). If it doesn't,
Redis has lost data, so the watchdog re-registers the schedule and sweeps at
once, treating `pending` events of any age as stranded. `delivering` keeps its
5-minute age guard because a worker may still be holding it. The check
touches Redis only, so it doesn't wake a suspended Postgres. A test in
`tests/reconciler.test.js` covers the re-registration.

### D3: no restart, after the fix (all defaults)

| | |
| --- | --- |
| Accepted (`202`) | 50,000 of 50,000 in 69.674 s |
| Queue at the flush (08:36:10) | 23,468 waiting, 5 active (23,573 Redis keys) |
| Watchdog | 08:36:34: "reconciler schedule was missing (Redis data loss?); re-registered it, sweeping now" |
| Sweep, logged on completion at 08:38:50 | `scanned: 40534, reEnqueued: 40534` |
| All terminal | 191.091 s after ingest ended: 50,000 delivered, 0 dead |
| Receiver | 50,000 unique, **0 missing, 0 duplicates**, 0 unexpected |

The watchdog fired while ingest was still running, so the sweep's snapshot
held 40,534 `pending` events: the 23,542 stranded by the flush plus events
ingested after it. The sweep then took 136 s. By the time it reached some of
those later events, their own jobs had completed and been removed, so it added
new ones. The worker's status guard (`src/worker.js`) skipped each of those,
which is why the receiver saw every event exactly once. `reEnqueued` counts
enqueue calls, not extra deliveries.

## 2. Throughput and latency — 5,000 events/min for 15 min

`throughput.js` is open loop: event *i* is sent at `start + i × 12 ms`
whether or not earlier requests have returned, so a slow engine can't lower
the offered load. Backlog = accepted events not yet terminal in Postgres,
sampled every 10 s.

| | T2 | T3 | T1 (contaminated) |
| --- | --- | --- | --- |
| Sent / accepted | 75,000 / 75,000 | 75,000 / 75,000 | 75,000 / 75,000 |
| Offered rate | 5,000/min | 5,000/min | 5,000/min |
| Max generator lag behind schedule | 160 ms | 33 ms | 469 ms |
| Delivered inside the 900 s load window | 74,997 (4,999/min) | 74,999 (4,999/min) | 74,966 of its own |
| Backlog at end of load / max sampled | 1 / 9 | 1 / 4 | 34 / 351 |
| Drained after load ended | 0.095 s | 0.089 s | 2.519 s |
| Ingest `202` latency p50 / p95 / p99 / max | 14 / 25 / 47 / 260 ms | 13 / 23 / 25 / 116 ms | 17 / 63 / 327 / 1,408 ms |
| **End-to-end p50 / p95 / p99 / max** | **25 / 47 / 139 / 418 ms** | **23 / 33 / 38 / 170 ms** | 32 / 1,026 / 4,350 / 5,782 ms |
| Missing / double-sends at receiver | 0 / 0 | 0 / 0 | 0 / 0 |

5,000/min was held with a flat backlog in T2 and T3. In T2 the first three
minutes had the highest tail (per-minute p95 of 93, 202 and 90 ms, then 26–40
ms for the remaining 12 minutes). In T3 every minute's p95 was 26–36 ms.

T1 is reported because it happened. Its minute-1 tail overlaps S4's 1,435
re-enqueued events, but minutes 3 (p95 5,006 ms) and 10 (p95 1,509 ms) had
stalls with no cause found in the engine log (no warnings or errors). The
likeliest cause is contention on the shared laptop or the Docker VM, but
that's an assumption, not a measurement. T1 therefore shows the engine
**can** stall for seconds on this setup.

## 3. Idempotency — duplicates, 10,000 events

There are two different dedup mechanisms in this codebase. "Duplicate
enqueue" can mean either, so each has its own phase:

- **Ingest idempotency key** — the one a client hits. `Idempotency-Key` is
  read at `src/routes/events.js:63`. The event row is inserted with
  `ON CONFLICT (idempotency_key) DO NOTHING` (`src/routes/events.js:68-74`),
  backed by `idempotency_key TEXT NOT NULL UNIQUE`
  (`migrations/002_create_event_and_delivery_attempt.sql:14`). On a conflict
  the route returns `200` with the original event and **never calls the
  queue** (`src/routes/events.js:76-83`). A duplicate request doesn't
  reach BullMQ at all.
- **BullMQ `jobId = event.id`** — internal. `enqueueDelivery` sets
  `jobId: eventId` (`src/queue.js:40-45`), so adding an event id that already
  has a job is a no-op. This is what protects the reconciler's re-enqueue and
  an ingest retry after a failed enqueue. It only dedups while the first job
  still exists: `removeOnComplete: true` (`src/queue.js:32`) deletes a job once
  it succeeds. After that, a re-enqueue is stopped by the worker's status guard
  (`src/worker.js:45-50`: skip if already `delivered`).

| Phase | Input | Engine outcome | Receiver |
| --- | --- | --- | --- |
| A. Same `Idempotency-Key` twice over HTTP (5,000 pairs concurrent, 5,000 back to back) | 20,000 requests, 10,000 keys | 10,000 × `202` + 10,000 × `200`. Every pair returned one `202` and the same event id. 10,000 event rows. | 10,000 deliveries, **0 double-sends**, 0 missing |
| B. Same event id enqueued twice concurrently (`enqueueDelivery` × 2) | 20,000 enqueue calls, 10,000 events | BullMQ emitted 10,000 `duplicated` events (every second add was a no-op) | 10,000 deliveries, **0 double-sends**, 0 missing |
| C. Each B event enqueued again after it was delivered | 10,000 enqueue calls | 0 `duplicated` (the first jobs were already removed, so 10,000 new jobs ran). The worker guard skipped all: delivery attempts stayed at 10,000. | Still 10,000, **0 double-sends** |

Phase B inserts its event rows with the same SQL as the ingest route (status
`pending`) and calls `src/queue.js`'s `enqueueDelivery` directly, because
nothing on the public API enqueues one event twice. All phases used worker
concurrency 5 and one engine instance, so the case of two workers racing on
one event was not exercised.
