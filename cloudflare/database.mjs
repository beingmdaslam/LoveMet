import { Client } from "pg";

/**
 * Hyperdrive owns connection pooling. Create a lightweight Client per request,
 * connect, run the callback, and always close the client before returning.
 * Never cache a Client or connection string across Worker invocations.
 */
export async function withDatabase(env, callback, ClientConstructor = Client) {
  const connectionString = env?.HYPERDRIVE?.connectionString;
  if (typeof connectionString !== "string" || !connectionString) {
    throw new Error("Hyperdrive binding is not configured.");
  }

  const client = new ClientConstructor({ connectionString });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await callback(client);
  } finally {
    if (connected) await client.end();
  }
}

/**
 * Read-only readiness gate for the complete Cloudflare schema. In particular,
 * email OTP must not be reported healthy until its reviewed migration exists.
 */
export async function isSchemaReady(client) {
  const result = await client.query(`
    SELECT
      to_regclass('public.users') IS NOT NULL
      AND to_regclass('public.otp_challenges') IS NOT NULL
      AND to_regclass('public.email_otp_challenges') IS NOT NULL
      AND to_regclass('public.sessions') IS NOT NULL
      AND to_regclass('public.contact_requests') IS NOT NULL
      AND to_regclass('public.messages') IS NOT NULL
      AND to_regclass('public.call_invites') IS NOT NULL
      AND to_regclass('public.user_blocks') IS NOT NULL
      AND to_regclass('public.user_reports') IS NOT NULL
      AND to_regclass('public.api_rate_limits') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name = 'email'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name = 'email_verified_at'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name = 'phone_e164' AND is_nullable = 'YES'
      )
      AND EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'users'
          AND indexname = 'users_email_unique_idx'
      )
      AND EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'users'
          AND indexdef ILIKE 'CREATE UNIQUE INDEX%phone_e164%'
      )
      AND EXISTS (
        SELECT 1 FROM pg_class
        WHERE oid = to_regclass('public.email_otp_challenges')
          AND relrowsecurity = TRUE
      ) AS ready
  `);
  return result.rows?.[0]?.ready === true;
}
