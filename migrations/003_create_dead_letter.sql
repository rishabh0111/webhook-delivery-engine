-- A dead_letter row records an event that exhausted its retries or hit a
-- permanent failure. The event row itself is reused on replay (preserving its
-- idempotency key and attempt history), so an event can accumulate more than
-- one dead_letter row across replay cycles — hence no UNIQUE on event_id.
--
-- replayed_at is stamped when an operator replays this dead letter.
CREATE TABLE IF NOT EXISTS dead_letter (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id    UUID NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    replayed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_event ON dead_letter (event_id);