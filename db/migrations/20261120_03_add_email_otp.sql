-- Add email as an alternative verified sign-in identity for Cloudflare OTP.
ALTER TABLE public.users ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON public.users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.email_otp_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_otp_challenges_email_created_idx
  ON public.email_otp_challenges (email, created_at DESC);
CREATE INDEX IF NOT EXISTS email_otp_challenges_expires_idx
  ON public.email_otp_challenges (expires_at);
ALTER TABLE public.email_otp_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.email_otp_challenges FROM anon, authenticated;
