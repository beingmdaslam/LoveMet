import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("email OTP migration keeps email login compatible with existing phone accounts", async () => {
  const sql = await readFile(new URL("../db/migrations/20261120_03_add_email_otp.sql", import.meta.url), "utf8");
  assert.match(sql, /ALTER TABLE public\.users ALTER COLUMN phone_e164 DROP NOT NULL/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS email TEXT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON public\.users \(lower\(email\)\) WHERE email IS NOT NULL/i);
});

test("email OTP challenge storage has expiry, bounded attempts and server-only access", async () => {
  const sql = await readFile(new URL("../db/migrations/20261120_03_add_email_otp.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.email_otp_challenges/i);
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /attempts SMALLINT NOT NULL DEFAULT 0 CHECK \(attempts BETWEEN 0 AND 5\)/i);
  assert.match(sql, /consumed_at TIMESTAMPTZ/i);
  assert.match(sql, /ALTER TABLE public\.email_otp_challenges ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.email_otp_challenges FROM anon, authenticated/i);
});

test("base schema and migration agree on nullable phone and email verification columns", async () => {
  const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  assert.match(schema, /phone_e164 TEXT UNIQUE/i);
  assert.match(schema, /email TEXT/i);
  assert.match(schema, /email_verified_at TIMESTAMPTZ/i);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS email_otp_challenges/i);
});

test("email OTP preflight is read-only and checks the existing identity schema", async () => {
  const sql = await readFile(new URL("../db/migrations/20261120_03_preflight.sql", import.meta.url), "utf8");
  assert.match(sql, /READ-ONLY preflight/i);
  assert.match(sql, /to_regclass\('public\.users'\)/i);
  assert.match(sql, /column_name = 'phone_e164' AND is_nullable = 'NO'/i);
  assert.match(sql, /column_name = 'email'/i);
  assert.match(sql, /column_name = 'email_verified_at'/i);
  const executableSql = sql.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(executableSql, /\b(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|GRANT|REVOKE)\s+(?:TABLE|INDEX|COLUMN|INTO|SET|ALL|[A-Z])/i);
});
