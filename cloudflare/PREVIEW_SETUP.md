# Cloudflare preview setup checklist

This is an operator checklist for the LoveMet Cloudflare preview. It does not deploy the Worker, change DNS, or modify the existing Node production service.

## 1. Prepare a dedicated Supabase database login

1. Open the Supabase Dashboard for the LoveMet project and go to **SQL Editor**.
2. Review [`hyperdrive-role.sql.example`](./hyperdrive-role.sql.example). It is a template only; it has not been run.
3. Replace the password placeholder with a unique, long random password, then execute the SQL as the database owner. It creates a login role with no superuser, database-creation, role-creation, or RLS-bypass privileges; it grants CRUD only on LoveMet's ten application tables and adds RLS policies only for that backend role.
4. Confirm the verification query reports all four privileges as `true` for the ten tables. Do not grant this role to `anon` or `authenticated`.
5. Store the new database password securely. Never paste it into ChatGPT, GitHub, source files, or `.dev.vars.example`.

This backend role can read and write account data across users because the server enforces LoveMet's session and relationship authorization. Its credentials must remain exclusively in Cloudflare Hyperdrive.

## 2. Create Hyperdrive

1. Open the Cloudflare dashboard and select the account that will own the preview Worker.
2. Open **Workers & Pages → Hyperdrive** and create a Hyperdrive configuration.
3. Use the Supabase project's **Direct connection** PostgreSQL endpoint, database name, and the dedicated `lovemet_worker` login as the origin. Do not use the Supavisor pooled connection; Hyperdrive provides connection pooling.
4. Keep the connection string private. Do not paste it into chat, GitHub issues, source files, or `.dev.vars.example`.

## 3. Bind Hyperdrive to the preview Worker

1. Open **Workers & Pages → lovemet-cloudflare-preview → Settings → Bindings**.
2. Add a **Hyperdrive** binding named exactly `HYPERDRIVE` and select the configuration created above.
3. Confirm the binding is attached to the preview Worker environment, not an unrelated Worker or production service.
4. Record the Hyperdrive configuration ID privately for the repository's Wrangler configuration step. Do not commit credentials.

## 4. Add runtime secrets

Use the Cloudflare Worker **Settings → Variables and Secrets** page to add secrets. Do not use plaintext variables for secret values.

- `OTP_HASH_SECRET`: a cryptographically random value of at least 32 characters.
- `RESEND_API_KEY`: required for email OTP; configure a verified sender as `RESEND_FROM_EMAIL`.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`: optional SMS OTP; real SMS may incur provider charges.
- `TURN_URLS`, `TURN_SHARED_SECRET`: optional TURN relay configuration for calls on restrictive networks; relay bandwidth may incur charges.

Never send secret values in ChatGPT or commit them to Git.

## 5. Preview verification sequence

After the `HYPERDRIVE` binding and required secrets are configured:

1. Add the real Hyperdrive ID to the Wrangler binding configuration and review the diff.
2. Run `npm test`, `npm run cf:check`, and `npm run cf:smoke`.
3. Deploy only to a separate preview Worker after explicit owner approval; do not change DNS or production routes.
4. Check `/healthz`. It must return HTTP 200 with `ok: true`, `database: connected`, and `schema: ready`.
5. Test signup/login, profile, contacts, messages, blocks/reports, account deletion, and call signaling with test accounts and non-production data.
6. Verify email delivery using the configured sender. Test SMS only if Twilio is configured and costs are understood.
7. Test two real Android devices, including camera/microphone permissions, reconnects, background/foreground transitions, and restrictive networks.
8. Keep the Node backend available as rollback. Do not cut over DNS until all checks and privacy/legal review pass.

## Current state

- The approved email OTP schema migration has been applied and verified on the connected Supabase project.
- Automated unit tests, Wrangler dry-run, and local Workers smoke tests are passing on the latest code commit.
- No Hyperdrive binding ID or provider secrets are configured in this repository.
- No Cloudflare deployment or DNS change has been performed.