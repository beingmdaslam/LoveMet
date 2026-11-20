# Cloudflare deployment and migration plan

Deployment is intentionally deferred. This document records the chosen target architecture and the compatibility work required before any production deployment.

## Target architecture

- **Cloudflare Workers Static Assets** serves the existing `public/` frontend over HTTPS.
- **Cloudflare Worker** handles HTTP API requests and WebSocket upgrade requests.
- **Durable Objects (SQLite-backed)** own individual chat/signaling rooms so connections are coordinated across Worker isolates. The Free plan supports SQLite-backed Durable Objects; do not use the legacy key-value storage backend.
- **Cloudflare Hyperdrive + node-postgres (`pg`)** connects the Worker to the existing Supabase PostgreSQL database. Keep the existing Supabase schema and server-side access model; never expose database credentials or service-role secrets to browser code.
- **Supabase PostgreSQL** remains the source of truth for accounts, sessions, contacts, messages, reports, call invitations and rate limits.
- **R2** may be used later for user-uploaded avatars and message attachments, after upload validation and authorization are implemented.

## Initial Worker scaffold (not deployed)

The repository now includes:

- Root `wrangler.jsonc` pointing at `cloudflare/worker.mjs` and the existing `public/` directory.
- A Worker entry that delegates non-API requests to the `ASSETS` binding.
- Explicit Worker-first routing for `/api`, `/healthz`, `/chat` and `/signal`.
- A deliberate HTTP 503 response for those backend routes until their Fetch-native and Durable Object implementations are ready. This prevents a preview Worker from falsely appearing healthy or accepting unauthenticated/unsupported traffic.
- Automated tests covering static asset delegation, missing bindings and fail-closed API/WebSocket behavior.

This is a local configuration/code scaffold only. It has not been deployed, and it does not replace the current Node server. There is intentionally no deploy script or production routing change.

## Important migration constraints

The current production backend is a Node HTTP server (`server.js`) using `http.createServer`, `ws`, filesystem static serving and a module-level `pg.Pool`. It cannot be deployed unchanged as a Workers entry point. Cloudflare Workers use the Fetch API and WebSocketPair/Durable Objects rather than hosting a long-running Node HTTP server.

The current `src/auth.js` and `src/social.js` handlers use Node request/response streams and module-level environment configuration. Before routing production traffic to Workers, refactor them into Fetch-native handlers with explicit request-scoped bindings, while preserving their existing validation, transaction boundaries, authorization checks, rate limits and response semantics.

Use Cloudflare's supported Node.js compatibility for the PostgreSQL driver, and initialize the database pool from the Hyperdrive binding. Verify all required `pg` APIs and transaction behavior in the Workers runtime; do not assume that Node compatibility means the whole current server is compatible.

## Free-plan guardrails (verify again before deployment)

As documented by Cloudflare on 2026-11-20:
- Workers Free: 100,000 requests/day and 10 ms CPU time per invocation.
- Hyperdrive Free: 100,000 database statements/day.
- Durable Objects Free: SQLite-backed objects only, 100,000 requests/day and 13,000 GB-s/day; WebSocket hibernation should be used to reduce idle duration charges.
- Static asset requests are free and unlimited.
- R2 has a free allowance, but actual storage and operation use must be monitored.

These are quotas, not a promise that every production traffic level will remain free. Add usage monitoring and spending safeguards before launch. SMS delivery and TURN relay bandwidth are separate dependencies and must not be described as guaranteed free.

## Migration order

1. Add a Workers entry point and Wrangler configuration without changing the existing Node deployment or frontend behavior.
2. Move static asset serving to Workers Static Assets and verify all existing pages, manifest and service worker paths.
3. Refactor authentication and social APIs to Fetch-native handlers, preserving the existing Supabase schema and security invariants.
4. Add Hyperdrive database access and run integration tests against a non-production/test account set.
5. Implement Durable Object chat and call signaling, including session checks, invitation authorization, block checks, participant limits, reconnect grace and message size limits.
6. Add TURN strategy, real-network two-device tests, Android background/permission tests, moderation and retention procedures.
7. Only after all checks pass and the owner explicitly approves, configure production secrets and deploy.

## Non-negotiable safeguards

- Do not run `wrangler deploy`, create paid resources, enable paid plans or change DNS without explicit approval.
- Do not put secrets in Git, `wrangler.toml`, frontend code or logs. Use Cloudflare secrets/bindings.
- Do not weaken authentication, origin validation, per-user rate limits, blocking, reporting, account deletion or database RLS during migration.
- Keep the existing Node server working until the Worker implementation passes equivalent automated and integration tests.
- No production cutover until HTTPS, database connectivity, OTP delivery, TURN, two-device calls, privacy/legal review and rollback procedures are verified.
