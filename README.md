# Webhook Delivery Engine

A self-hostable webhook delivery engine. It accepts an event for a pre-registered
subscription, **durably persists it**, and guarantees one of two terminal outcomes:

- **delivered** — the receiver acknowledged with a `2xx`, or
- **explicit failure** — the event is dead-lettered after exhausting retries, fully
  recorded and replayable.

Every HTTP attempt is recorded. Deliveries are signed (Stripe-style HMAC) so receivers
can verify authenticity and reject replays. Operators get a live dashboard, a metrics
endpoint, Swagger docs, and one-click replay.

The whole system is designed to run — and *stay* running — on free infrastructure, so the
architecture is shaped around the metering limits of the free tiers it targets.

## System architecture

![Webhook Delivery Engine — system architecture](docs/images/architecture-overview.png)

*Ingest → durably persist → commit → enqueue → deliver, with Postgres as the authoritative
store, Redis/BullMQ as a disposable scheduler, a reconciler backstop for the
crash-after-commit gap, and an operator-driven replay path out of the dead-letter store.*

## Architecture at a glance

- **Express API + BullMQ worker in one Node process.** The worker is its own module so it
  *could* split into a separate service with a one-line change (see [Production Gaps](#production-gaps)).
- **Postgres is authoritative for business status; Redis/BullMQ is a disposable scheduler.**
  Delivery is at-least-once with idempotent worker operations.
- **Outbox pattern.** `POST /api/events` persists the event and commits *before* enqueuing.
  The commit is the durable point of no return; a failed enqueue is harmless because
  `jobId = event.id` makes a duplicate enqueue a no-op.
- **Reconciler backstop.** A repeatable job (~every 15 min) re-enqueues non-terminal events
  that have no live job — closing the crash-after-commit gap and recovering from Redis data
  loss.
- **Smart failure classification.** `2xx` → delivered; timeout / network / `429` / `408` /
  `5xx` → retry with exponential backoff (≈ 60s → 120s → 240s → 480s, 5 attempts); other
  `4xx` → dead-letter immediately.

## Data model

Four tables, owned by the migrations in [migrations/](migrations/):

- **`subscription`** — a delivery destination: `target_url`, an optional signing `secret`,
  and a `description`. The secret is returned **once** at creation and never re-exposed.
- **`event`** — one ingested payload bound to a subscription. Holds the exact `raw_body`
  bytes, the `idempotency_key` (unique), and a single `status`:
  `pending → delivering → delivered | dead`. Postgres is authoritative for this status.
- **`delivery_attempt`** — an append-only audit row per HTTP attempt (`attempt_number`,
  `status_code`, `duration_ms`, truncated `response_body`, `error`). `attempt_number` is
  monotonic per event and survives replays.
- **`dead_letter`** — written when an event goes `dead`, carrying the failure `reason` and a
  `replayed_at` stamp that a successful replay sets.

## Quick start

```bash
# 1. Bring up Postgres + Redis (memory-metered Redis with noeviction; see docker-compose.yml)
docker compose up -d

# 2. Configure
cp .env.example .env        # defaults already point at the docker services

# 3. Migrate + run
npm install
npm run migrate
npm start                   # API + worker on http://localhost:3000
```

The `migrate` / `start` / `seed` scripts auto-load `.env` via Node's built-in
`--env-file-if-exists` (Node ≥ 20.12), so no manual exports are needed. Variables already set
in your shell take precedence, and when no `.env` exists (e.g. a hosted deploy) the scripts
fall back to the platform's environment.

- **Dashboard:** http://localhost:3000/dashboard
- **API docs (Swagger UI):** http://localhost:3000/docs

### Run the tests

```bash
docker compose up -d
DATABASE_URL=postgres://postgres:postgres@localhost:5432/webhooks \
REDIS_URL=redis://localhost:6379 \
NODE_ENV=test \
npm test
```

## API surface

| Method & path | Purpose |
| --- | --- |
| `POST /api/subscriptions` | Register a destination; returns the signing secret **once**. |
| `GET /api/subscriptions` | List destinations (`has_secret` only — secret never re-exposed). |
| `DELETE /api/subscriptions/:id` | Remove a destination. |
| `POST /api/events` | Ingest an event (`202` new / `200` idempotency-key conflict). |
| `GET /api/events` | Recent events with attempt timelines. |
| `GET /api/events/:id` | One event with its full attempt timeline. |
| `GET /api/events/:id/signature` | The signature a receiver should expect for this event. |
| `POST /api/dead-letters/:id/replay` | Replay a dead-lettered event (idempotent; `409` if not dead). |
| `GET /metrics` | Queue depth + event counts by status (cached ~10s). |
| `GET /health` | Shallow liveness (no DB/Redis — safe keep-alive target). |
| `GET /health/ready` | Deep readiness (Postgres + Redis). |
| `GET /docs` | Live Swagger UI. |
| `GET /dashboard` | Live operator dashboard. |

Ingestion routing/idempotency metadata travel in **headers** (`X-Subscription-Id`,
`Idempotency-Key`) so the request **body is the exact payload bytes** to deliver, captured
verbatim and signed without re-serialization.

## Signature verification recipe

Every signed delivery carries three headers:

| Header | Meaning |
| --- | --- |
| `X-Webhook-Id` | The event id — stable across retries/replays, for receiver-side dedup. |
| `X-Webhook-Timestamp` | Unix seconds when the signature was computed. |
| `X-Webhook-Signature` | `sha256=<hex>` — the HMAC. |

The signature is:

```
HMAC-SHA256(secret, timestamp + "." + raw_body)
```

computed over the **exact raw bytes** that were delivered — never a re-serialization, so it
is byte-stable across languages, whitespace, and key ordering.

To verify a delivery:

1. Read `X-Webhook-Timestamp` and `X-Webhook-Signature`.
2. Recompute `HMAC-SHA256(your_secret, timestamp + "." + rawRequestBody)` over the raw body
   bytes (do **not** parse-then-re-stringify the JSON first).
3. Compare against the header value using a **constant-time** comparison.
4. Reject if the timestamp is outside your tolerated replay window (e.g. ±5 minutes).

### Node.js example

```js
const crypto = require('crypto');

// `rawBody` MUST be the exact bytes received (e.g. express.raw()), not a parsed object.
function verify(secret, rawBody, headers, toleranceSeconds = 300) {
  const timestamp = headers['x-webhook-timestamp'];
  const received = headers['x-webhook-signature']; // "sha256=<hex>"

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!timestamp || age > toleranceSeconds) return false; // replay window

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');

  const a = Buffer.from(received || '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

The dashboard surfaces the signature for a test event, and `GET /api/events/:id/signature`
returns it programmatically, so you can validate your implementation end-to-end.c