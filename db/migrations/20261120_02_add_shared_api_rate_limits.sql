-- Shared API rate limits across backend instances.
CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  key_hash TEXT PRIMARY KEY CHECK (char_length(key_hash) = 64),
  hit_count INTEGER NOT NULL CHECK (hit_count > 0),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS api_rate_limits_expires_idx
  ON public.api_rate_limits (expires_at);
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.api_rate_limits FROM anon, authenticated;
