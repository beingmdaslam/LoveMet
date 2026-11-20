-- LoveMet account foundation. Apply with a PostgreSQL migration runner.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 TEXT NOT NULL UNIQUE,
  display_name TEXT,
  username TEXT UNIQUE,
  avatar_url TEXT,
  phone_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS otp_challenges_phone_created_idx
  ON otp_challenges (phone_e164, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
