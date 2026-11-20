-- READ-ONLY preflight for 20261120_03_add_email_otp.sql.
-- Run in the Supabase SQL editor before applying the migration.
-- This file performs SELECTs only; it does not alter data, schema, or privileges.

SELECT
  to_regclass('public.users') IS NOT NULL AS users_table_exists,
  to_regclass('public.otp_challenges') IS NOT NULL AS phone_otp_table_exists,
  to_regclass('public.sessions') IS NOT NULL AS sessions_table_exists,
  to_regclass('public.email_otp_challenges') IS NOT NULL AS email_otp_table_already_exists,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
      AND column_name = 'phone_e164' AND is_nullable = 'NO'
  ) AS phone_is_currently_required,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
      AND column_name = 'email'
  ) AS email_column_already_exists,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
      AND column_name = 'email_verified_at'
  ) AS email_verified_column_already_exists;

-- Expected before migration on the current Supabase project:
-- users_table_exists=true, phone_otp_table_exists=true, sessions_table_exists=true,
-- phone_is_currently_required=true, email_column_already_exists=false,
-- email_verified_column_already_exists=false, email_otp_table_already_exists=false.
-- If the actual results differ, stop and review before applying the migration.
