-- Improve participant-wide busy-call checks and stale invitation expiry scans.
CREATE INDEX IF NOT EXISTS call_invites_active_caller_expiry_idx
  ON public.call_invites (caller_id, expires_at)
  WHERE status IN ('ringing', 'accepted');

CREATE INDEX IF NOT EXISTS call_invites_active_callee_expiry_idx
  ON public.call_invites (callee_id, expires_at)
  WHERE status IN ('ringing', 'accepted');
