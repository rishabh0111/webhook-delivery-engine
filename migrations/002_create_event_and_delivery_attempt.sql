-- An event is one payload destined for exactly one subscription.
--
-- raw_body: the EXACT bytes received on POST /api/events, stored verbatim as
-- bytea. This is the artifact that is signed (later slice) and delivered — it
-- is never re-serialized, so signatures stay byte-exact.
--
-- idempotency_key: UNIQUE. Caller-supplied (recommended) or an auto-generated
-- UUID fallback. The UNIQUE constraint is the ingestion-dedup mechanism.
--
-- status lifecycle: pending -> delivering -> delivered | failed | dead.
CREATE TABLE IF NOT EXISTS event (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL UNIQUE,
    raw_body        BYTEA NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dead')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per HTTP attempt. attempt_number is monotonic per event and
-- append-only across replays, preserving the full audit trail.
CREATE TABLE IF NOT EXISTS delivery_attempt (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id       UUID NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    attempt_number INT NOT NULL,
    status_code    INT,
    duration_ms    INT,
    response_body  TEXT,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempt_event ON delivery_attempt (event_id);
-- Supports the reconciler's sweep for non-terminal events (later slice).
CREATE INDEX IF NOT EXISTS idx_event_status ON event (status);