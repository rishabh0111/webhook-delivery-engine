# Webhook Delivery Engine

![Node.js](https://img.shields.io/badge/Node.js-5FA04E?style=flat&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=flat&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-FF4438?style=flat&logo=redis&logoColor=white)
![BullMQ](https://img.shields.io/badge/BullMQ-E10098?style=flat&logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)
![Swagger](https://img.shields.io/badge/OpenAPI-6BA539?style=flat&logo=openapiinitiative&logoColor=white)

**[Read the write-up](https://rishabh0111.github.io/blogs/webhook-delivery-engine/)**  ·
[Live dashboard](https://webhook-delivery-engine-on21.onrender.com/dashboard)  ·
[Swagger docs](https://webhook-delivery-engine-on21.onrender.com/docs)

A self-hostable webhook delivery engine. It accepts an event for a pre-registered
subscription, durably persists it, and drives it to exactly one terminal state —
**delivered** (receiver returned `2xx`) or **dead** (retries exhausted or a
permanent failure), dead-lettered with a recorded reason and a one-click replay.
Every HTTP attempt is recorded; signed deliveries use a Stripe-style HMAC.

> Once `POST /api/events` returns `202`, the event reaches exactly one of
> `delivered` or `dead`, and every attempt in between is recorded and auditable.

The **why** behind every design decision — the outbox pattern, failure
classification, the reconciler, replay safety, signing the raw bytes, and
building it all to run on $0 of infrastructure — is in
**[the write-up](https://rishabh0111.github.io/blogs/webhook-delivery-engine/)**.
This README is the operational reference.

## Architecture

```mermaid
flowchart TD
    Producer([Client / Producer]) -->|"POST /api/events<br/>raw bytes + headers"| API
    Operator([Operator<br/>dashboard · /metrics]) -->|replay dead-letter| API
    API[Express API<br/>subscriptions · events · replay<br/>metrics · health · docs]
    API -->|"2 · enqueue jobId = event.id"| Redis
    Reconciler[Reconciler<br/>~15 min repeatable] -->|re-enqueue| Redis
    Redis[(Redis + BullMQ<br/>disposable scheduler)] -->|dequeue| Worker
    Worker[BullMQ Worker<br/>concurrency 5] -->|"POST signed delivery<br/>HMAC-SHA256"| Receiver
    Receiver([Receiver<br/>subscriber endpoint]) -.->|"2xx OK · 5xx/429/408/timeout retry · 4xx dead"| Worker
    API -->|"1 · INSERT pending, COMMIT"| Postgres
    Reconciler -->|scan stale events| Postgres
    Worker -->|delivery_attempt + status| Postgres
    Postgres[(PostgreSQL · authoritative<br/>subscription · event · delivery_attempt · dead_letter)]
    classDef actor fill:#DBEAFE,stroke:#2563EB,stroke-width:2px,color:#1E3A8A
    classDef gateway fill:#EDE9FE,stroke:#7C3AED,stroke-width:2px,color:#4C1D95
    classDef service fill:#D1FAE5,stroke:#059669,stroke-width:2px,color:#065F46
    classDef store fill:#CFFAFE,stroke:#0891B2,stroke-width:2px,color:#164E63
    class Producer,Operator,Receiver actor
    class API gateway
    class Reconciler,Worker service
    class Redis,Postgres store
```

Postgres is authoritative for business state; Redis/BullMQ is a disposable
scheduler. Losing Redis entirely loses no events — the reconciler rebuilds the
work queue from Postgres. The API and worker run in one Node process; the worker
is an isolated module and splitting it out is a deployment change.

## Quick start

```bash
docker compose up -d          # Postgres + Redis (see docker-compose.yml)
cp .env.example .env          # defaults already point at the docker services
npm install
npm run migrate
npm start                     # API + worker on http://localhost:3000
```

- Dashboard: http://localhost:3000/dashboard
- Swagger UI: http://localhost:3000/docs

Scripts auto-load `.env` via Node's `--env-file-if-exists` (Node ≥ 20.12);
shell variables take precedence, and with no `.env` the scripts fall back to the
platform environment. Config reference: [.env.example](.env.example).

A deployment of this is live at
[webhook-delivery-engine-on21.onrender.com](https://webhook-delivery-engine-on21.onrender.com/dashboard)
(free instance — the first request after idle takes a few seconds to wake).

### Tests

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

Routing and idempotency metadata travel in **headers** (`X-Subscription-Id`,
`Idempotency-Key`) so the request body stays the exact payload bytes — captured
verbatim, signed without re-serialization, delivered byte for byte.

## Signature verification

Signed deliveries carry `X-Webhook-Id` (stable across retries — dedup on it),
`X-Webhook-Timestamp`, and `X-Webhook-Signature` (`sha256=<hex>`):

```
HMAC-SHA256(secret, timestamp + "." + raw_body)
```

computed over the **raw bytes** delivered, never a re-serialization. Full recipe
with Node and Python implementations:
[docs/signature-verification.md](docs/signature-verification.md).
`GET /api/events/:id/signature` returns the expected value so you can check your
implementation.

## Data model

Four tables, owned by [migrations/](migrations/):

- **`subscription`** — a destination: `target_url`, optional signing `secret`
  (returned once, never re-exposed), `description`.
- **`event`** — one ingested payload bound to a subscription. Stores the exact
  `raw_body` bytes, a unique `idempotency_key`, and a single authoritative
  `status`: `pending → delivering → delivered | dead`.
- **`delivery_attempt`** — append-only audit row per HTTP attempt
  (`attempt_number` monotonic per event and surviving replays, `status_code`,
  `duration_ms`, truncated `response_body`, `error`).
- **`dead_letter`** — written when an event goes `dead`; carries the failure
  `reason` and a `replayed_at` stamp set by a successful replay.

## Demo mode

The dashboard ships a zero-setup walkthrough of every delivery outcome (happy
path, retry-then-success, timeout, permanent failure, exhausted retries,
idempotency conflict, replay), gated behind `DEMO_MODE` (on by default outside
production). It adds an in-process receiver with controllable outcomes, one
subscription per outcome via seed data, a runtime "fast mode" that compresses
retry backoff to ~2s with no redeploy, and on-demand reconciler / reset
controls. Seed from the CLI with `npm run seed`. Production timing is untouched
when fast mode is off.

## Not production-ready — by design

Consciously scoped out; each is bounded work, not an oversight. The reasoning is
in [the write-up](https://rishabh0111.github.io/blogs/webhook-delivery-engine/#what-i-deliberately-left-out-and-why).

- Authentication / authorization and per-tenant isolation — the API is open.
- Topic fan-out (one event → many subscriptions) — needs a per-target `delivery`
  entity split from `event`.
- Per-subscription FIFO ordering — not guaranteed.
- Secret encryption at rest — stored plaintext (must be readable to sign).
- SSRF hardening — target URLs not validated against private/link-local ranges.
- Honoring `Retry-After` on `429` — currently retried with normal backoff.
- Web and worker as separate services — one process today (free-host constraint).

## License

MIT
