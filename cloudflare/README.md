# Cloudflare deployment and migration plan

Deployment is intentionally deferred. This document records the chosen target architecture and the compatibility work required before any production deployment.

## Target architecture

- **Cloudflare Workers Static Assets** serves the existing `public/` frontend over HTTPS.
- **Cloudflare Worker** handles HTTP API requests and WebSocket upgrade requests.
- **Durable Objects (SQLite-backed)** own individual chat/signaling rooms so connections are coordinated across Worker isolates. The Free plan supports SQLite-backed Durable Objects; do not use the legacy key-value storage backend.
- **Cloudflare Hyperdrive + node-postgres (`pg`)** connects the Worker to the existing Supabase PostgreSQL database. Keep the existing Supabase schema and server-side access model; never expose database credentials or service-role secrets to browser code.
- For the Hyperdrive origin, use Supabase's **Direct connection** string (not the Supavisor pooler); Hyperdrive supplies the pooling layer. The direct Supabase endpoint is IPv6 by default, so confirm the Cloudflare Hyperdrive configuration can reach it before considering any IPv4 add-on or alternate paid networking option. Use a dedicated database login with only the permissions the Worker needs; do not put a service-role API key in the Worker or browser.
- **Supabase PostgreSQL** remains the source of truth for accounts, sessions, contacts, messages, reports, call invitations and rate limits.
- **R2** may be used later for user-uploaded avatars and message attachments, after upload validation and authorization are implemented.

## Initial Worker scaffold (not deployed)

The repository now includes:

- Root `wrangler.jsonc` pointing at `cloudflare/worker.mjs` and the existing `public/` directory.
- A Worker entry that delegates non-API requests to the `ASSETS` binding.
- Explicit Worker-first routing for `/api`, `/healthz`, `/chat` and `/signal`.
- A SQLite-backed `CallRooms` Durable Object configured in `wrangler.jsonc`; `/signal?roomId=<invitation UUID>` routes each accepted invitation to its own hibernatable WebSocket room. A per-user `UserEvents` Durable Object now backs `/chat`, enforces a five-connection limit, revalidates sessions every 60 seconds, rejects client-originated frames, and fans out server-published messages/read receipts. It revalidates sessions and accepted call invitations on every signaling packet and every 60 seconds, enforces block checks and atomic serialized two-participant admission with stale-socket guards, caps signaling messages at 64 KiB and 300 frames per socket per minute, and preserves the 25-second reconnect grace with alarms.
- A request-scoped `pg` client adapter that reads the Hyperdrive connection string from the binding and always closes the client; Hyperdrive owns the underlying connection pool.
- `/healthz` requires both Durable Object namespaces and performs a read-only schema readiness check through Hyperdrive; it returns 503 until the full application schema, email OTP table/columns and nullable phone identity are present.
- Fetch-native `/api/auth/request-email-otp`, `/api/auth/verify-email-otp`, `/api/auth/request-otp`, `/api/auth/verify-otp`, `/api/auth/logout`, `/api/auth/me`, `/api/account`, `/api/profile`, `/api/contacts`, `/api/contacts/requests`, `/api/contacts/blocks`, `/api/users/search`, `/api/messages`, `/api/calls/config`, `/api/calls/history`, `/api/calls/status`, `/api/calls/invites`, `/api/calls/invite` and `/api/calls/respond`, `/api/contacts/request` and `/api/contacts/respond`, `/api/contacts/block`, `/api/contacts/unblock` and `/api/users/report` handlers validate the existing opaque session cookie against the Supabase `sessions` table. Email and phone OTP use scrypt-hashed, one-time challenges with per-IP/per-identifier rate limits, serialized issuance/verification, provider-delivery rollback and opaque 30-day sessions. Email OTP uses Resend's HTTP API and can operate within its free tier when account quotas and sender verification allow; phone SMS remains an optional Twilio path and may incur charges; logout revokes the session and ends active calls. Account deletion revalidates the session, removes OTP challenges and deletes the user transactionally before clearing the cookie. Profile updates retain same-origin protection, the 8 KiB body limit, field validation and unique-username conflict handling. Contact reads preserve accepted/pending filters and block exclusions; username search and blocked-user listing are ported too, with shared HMAC-keyed search limits. Message history retains cursor pagination and read-state updates; message sends use the shared HMAC-keyed database rate limiter, transaction-scoped pair locks and a second accepted-contact/block check before insert. Call configuration, history, incoming-invite and status polling reads are also ported, including short-lived HMAC TURN credentials when a TURN secret is configured. Contact request creation and accept/decline preserve the Node backend's pair-level transaction locks, block rechecks and shared request limits. Call invite/accept/decline/cancel/end routes also retain participant-wide busy locks, accepted-contact/block checks, and invitation quotas. Block/unblock and abuse-report handlers also preserve call termination, reporter transaction serialization and the five-reports-per-day limit. Live message/read-receipt, call-state and contact-state events are delivered through the per-user event Durable Objects; polling remains a fallback when realtime is unavailable.
- Unknown API routes and any real-time route whose Durable Object binding or database is unavailable return a deliberate HTTP 503. The Worker does not claim readiness when its required services are missing.
- Automated tests covering static asset delegation, missing bindings and fail-closed API/WebSocket behavior.

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in only test credentials. Keep real values in local ignored files or Cloudflare secrets; never commit them. Hyperdrive still requires a real binding ID and a secure Supabase connection string.

This is a local configuration/code scaffold only. It has not been deployed, and it does not replace the current Node server. There is intentionally no deploy script or production routing change.

## Runtime and credential readiness

The Cloudflare Worker now contains Fetch-native adapters for the currently identified authentication, profile, contacts, messages, user lookup, moderation, account and call API routes. The Node backend remains the production fallback. Ported handlers and Durable Object logic have unit coverage, but this is not equivalent to a live Workers-runtime integration test.

Before local or preview runtime testing, configure:

- `HYPERDRIVE`: a Cloudflare Hyperdrive binding connected to the existing Supabase PostgreSQL database. The binding must expose `connectionString`; no Hyperdrive ID or database URL is committed to this repository.
- `OTP_HASH_SECRET`: a random secret of at least 32 characters used for OTP hashing and keyed limits.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER`: required for real SMS delivery. Use test credentials or a mocked provider for tests; real SMS may incur charges.
- `TURN_URLS` and `TURN_SHARED_SECRET`: optional for issuing short-lived TURN credentials. Without a configured TURN relay, calls may fail on restrictive networks; relay bandwidth may incur charges.

For local development, copy `.dev.vars.example` to `.dev.vars` and use test-only values. For Cloudflare, store sensitive values as Worker secrets and configure the Hyperdrive binding separately. Never commit `.dev.vars`, real database URLs, API tokens or provider secrets. Do not paste secrets into chat.

Remaining readiness work includes configuring a Cloudflare Hyperdrive binding and validating it from a Workers runtime against a non-production/test dataset, exercising every API route and Durable Object path in that runtime, configuring and verifying real OTP delivery, and completing two-device Android and restrictive-network call tests. The production Supabase schema is ready, but Cloudflare has not been connected to it or deployed. Keep the Node backend available as rollback until all checks pass.

## Free-plan guardrails (verify again before deployment)

As documented by Cloudflare on 2026-11-20:
- Workers Free: 100,000 requests/day and 10 ms CPU time per invocation.
- Hyperdrive Free: 100,000 database statements/day.
- Durable Objects Free: SQLite-backed objects only, 100,000 requests/day and 13,000 GB-s/day; WebSocket hibernation should be used to reduce idle duration charges.
- Static asset requests are free and unlimited.
- R2 has a free allowance, but actual storage and operation use must be monitored.

These are quotas, not a promise that every production traffic level will remain free. Add usage monitoring and spending safeguards before launch. Email OTP can use a provider free tier subject to quotas and verified-sender requirements; SMS delivery and TURN relay bandwidth are separate dependencies and must not be described as guaranteed free.

## Migration order

1. Add a Workers entry point and Wrangler configuration without changing the existing Node deployment or frontend behavior.
2. Move static asset serving to Workers Static Assets and verify all existing pages, manifest and service worker paths.
3. Refactor authentication and social APIs to Fetch-native handlers, preserving the existing Supabase schema and security invariants. The email OTP migration `20261120_03_add_email_otp.sql` has now been applied to the connected Supabase project with owner approval. The live database was verified to contain all 10 required tables, email identity columns, nullable `phone_e164`, the unique lower(email) index, and an RLS-enabled email OTP table with no `anon` or `authenticated` table privileges. For any other environment, first run the read-only `db/migrations/20261120_03_preflight.sql`, review the results, then apply the migration and verify schema readiness.
4. Add Hyperdrive database access and run integration tests against a non-production/test account set.
5. Wire call/contact event publishing into the Durable Object path and complete Workers-runtime integration and two-device tests.
6. Add TURN strategy, real-network two-device tests, Android background/permission tests, moderation and retention procedures.
7. Only after all checks pass and the owner explicitly approves, configure production secrets and deploy.

## Non-negotiable safeguards

- Do not run `wrangler deploy`, create paid resources, enable paid plans or change DNS without explicit approval.
- Do not put secrets in Git, `wrangler.toml`, frontend code or logs. Use Cloudflare secrets/bindings.
- Do not weaken authentication, origin validation, per-user rate limits, blocking, reporting, account deletion or database RLS during migration.
- Keep the existing Node server working until the Worker implementation passes equivalent automated and integration tests.
- No production cutover until HTTPS, database connectivity, OTP delivery, TURN, two-device calls, privacy/legal review and rollback procedures are verified.
