-- A subscription is a pre-registered delivery destination.
--
-- secret: nullable. When present it is randomBytes(32) hex, stored in
-- plaintext because it must be readable later to sign each delivery (it is not
-- a password and cannot be hashed). NULL means "skip signing". The secret is
-- returned to the caller exactly once, on creation, and never again.
CREATE TABLE IF NOT EXISTS subscription (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_url  TEXT NOT NULL,
    secret      TEXT,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);