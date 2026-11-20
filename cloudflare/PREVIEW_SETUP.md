# Cloudflare preview setup checklist

This is an operator checklist for the LoveMet Cloudflare preview. It does not deploy the Worker, change DNS, or modify the existing Node production service.

## 1. Prepare a dedicated Supabase database login

1. Open the Supabase Dashboard for the LoveMet project and go to **SQL Editor**.
2. Review [`hyperdrive-role.sql.example`](./hyperdrive-role.sql.example). It is a template only; it has not been run.
3. Replace the password placeholder with a unique, long random password, then execute the SQL as the database owner. It creates a login role with no superuser, database-creation, role-creation, or RLS-bypass privileges; it grants CRUD only on LoveMet's ten application tables and adds RLS policies only for that backend role.
4. Confirm the verification query reports all four privileges as `true` for the ten tables. Do not grant this role to `anon` or `authenticated`.
5. Store the new database password securely. Never paste it into ChatGPT, GitHub, source files, or `.dev.vars.example`.

This backend role can read and write account data across users because the server enforces LoveMet's session and relationship authorization. Its credentials must remain exclusively in Cloudflare Hyperdrive.

## 2. Create and configure Hyperdrive

1. Open the Cloudflare dashboard and select the account that will own the preview Worker.
2. Open **Workers & Pages → Hyperdrive** and create/open the LoveMet Hyperdrive configuration.
3. Use the Supabase project's **Direct connection** PostgreSQL endpoint, database name, and the dedicated `lovemet_worker` login as the origin. Do not use the Supavisor pooled connection; Hyperdrive provides connection pooling.
4. Keep the connection string private. Do not paste it into chat, GitHub issues, source files, or `.dev.vars.example`.
5. The Hyperdrive configuration ID has been added to the repository's Wrangler configuration. Confirm the dashboard configuration's origin connection is saved and healthy before preview deployment.

## 3. Worker binding

The repository's `wrangler.jsonc` now declares the `HYPERDRIVE` binding and points it to the supplied Hyperdrive configuration ID. Wrangler will attach this binding when the preview Worker is deployed. Do not create a second binding with a different name. After preview deployment, verify that **Workers & Pages → lovemet-cloudflare-preview → Settings → Bindings** shows `HYPERDRIVE`.

## 4. Add runtime secrets

Use the Cloudflare Worker **Settings → Variables and Secrets** page to add secrets. Do not use plaintext variables for secret values.

- `OTP_HASH_SECRET`: a cryptographically random value of at least 32 characters.
- `RESEND_API_KEY`: required for email OTP; configure a verified sender as `RESEND_FROM_EMAIL`.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`: optional SMS OTP; real SMS may incur provider charges.
- `TURN_URLS`, `TURN_SHARED_SECRET`: optional TURN relay configuration for calls on restrictive networks; relay bandwidth may incur charges.

Never send secret values in ChatGPT or commit them to Git.

## 5. Preview verification sequence

After the Hyperdrive origin and required secrets are configured:

1. Confirm the Hyperdrive ID in `wrangler.jsonc` matches the configuration in Cloudflare.
2. Run `npm test`, `npm run cf:check`, and `npm run cf:smoke`.
3. Deploy only to a separate preview Worker after explicit owner approval; do not change DNS or production routes.
4. Check `/healthz`. It must return HTTP 200 with `ok: true`, `database: connected`, and `schema: ready`.
5. Test signup/login, profile, contacts, messages, blocks/reports, account deletion, and call signaling with test accounts and non-production data.
6. Verify email delivery using the configured sender. Test SMS only if Twilio is configured and costs are understood.
7. Test two real Android devices, including camera/microphone permissions, reconnects, background/foreground transitions, and restrictive networks.
8. Keep the Node backend available as rollback. Do not cut over DNS until all checks and privacy/legal review pass.

## Current state

- The approved email OTP schema migration has been applied and verified on the connected Supabase project.
- The supplied Hyperdrive configuration ID is saved in `wrangler.jsonc`; Wrangler's dry-run confirmed that `env.HYPERDRIVE` resolves to that configuration.
- All 157 unit tests and the Wrangler dry-run passed on the Hyperdrive-binding commit. Its local smoke test exposed a missing local Hyperdrive emulator URL; the smoke script has now been updated to supply a non-secret, local-only placeholder. CI verification of that fix is pending.
- The Hyperdrive ID being present in Git does not prove the database origin credentials/connectivity are valid. A live Worker preview check is still required.
- Provider secrets and live OTP delivery have not been verified.
- No Cloudflare deployment or DNS change has been performed.
