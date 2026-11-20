# LoveMet development roadmap

Deployment is intentionally postponed until the application has been implemented and tested.

## Phase 1 — Calling foundation
- [x] Responsive 1-to-1 calling screen
- [x] WebSocket signaling server (invitation UUID rooms)
- [x] Camera and microphone controls
- [x] Leave-call control
- [x] Authenticated call invitations and accept/decline flow
- [x] WebSocket signaling restricted to signed-in participants with accepted invitations
- [x] Short-lived per-user TURN credential delivery support
- [ ] TURN provider setup and real-network relay fallback testing
- [x] In-call elapsed timer
- [x] Short network interruption recovery with a 25-second signaling rejoin grace period and ICE restart
- [x] Prevent overlapping active/ringing calls with participant-level transaction locks
- [x] Front/rear camera switching
- [ ] Speaker/audio-route handling
- [ ] Call permission and device compatibility testing

## Phase 2 — Accounts and profiles
- [x] Phone OTP request/verification API foundation (PostgreSQL + Twilio adapter; requires deployment environment credentials and live integration test)
- [x] Persistent opaque sessions, HttpOnly cookie, logout/revocation and shared database-backed OTP rate limits with keyed identifier hashes (live deployment verification still pending)
- [x] Display name and username editing API + frontend UI (live database integration pending)
- [ ] Avatar upload and profile image management
- [x] Block/unblock controls and report submission API/UI

## Phase 3 — Contacts and messaging
- [x] Backend username search and contact-request API
- [x] Frontend username search and send-contact-request UI (live integration pending)
- [x] Backend incoming-request list and accept/decline API
- [x] Frontend incoming-request accept/decline UI (live integration pending)
- [x] Backend one-to-one text-message send/read API
- [x] Basic frontend one-to-one chat UI (live integration pending)
- [x] HTTP polling fallback for chat when live sockets are unavailable
- [x] Restore live chat sockets after mobile network returns or app tab becomes visible
- [x] Authenticated same-origin WebSocket live message delivery to sender and recipient
- [x] Immediate read-receipt delivery to the original sender
- [x] Same-origin WebSocket authentication, periodic session revalidation, and per-account socket limits
- [x] Bounded 50-message history pages with stable timestamp/UUID cursor and load-older UI
- [ ] Safe handling of attachments (if enabled)

## Phase 4 — Call management
- [x] Incoming call prompt with accept/decline
- [x] Live WebSocket call-invitation and response updates while users are online
- [x] Missed, incoming and outgoing call history
- [x] Basic call status, peer-end detection, and stale-session cleanup
- [x] Basic call history and elapsed duration (when both start/end timestamps are recorded)
- [ ] Push notifications for incoming calls/messages

## Phase 5 — Android experience
- [x] Installable PWA baseline (manifest, app icon, and privacy-safe shell service worker)
- [ ] Native Android wrapper/app decision
- [ ] Background/lock-screen call behavior
- [ ] Bluetooth headset and speaker routing
- [ ] Battery, network and permission testing on real Android devices

## Phase 6 — Security, privacy and quality
- [x] Basic block controls, categorized reports, and database-backed report limits
- [x] Shared per-account limits for username search, contact requests, call invitations and message sending
- [ ] Full threat model and staffed report-moderation workflow
- [ ] Authentication and authorization integration tests
- [x] Secure signaling origin/session/accepted-invite checks, same-origin mutation protection and input validation
- [x] Authenticated account deletion with cascading removal of contacts, messages, sessions, call history, and OTP challenges
- [ ] Formal retention schedule and deletion-request policy
- [x] Draft privacy notice and terms pages (operator/legal review and contact details required before launch)
- [ ] Accessibility and low-bandwidth behavior
- [ ] Automated tests and production readiness review

## Cloudflare migration
- [x] Add non-deployed Wrangler configuration for the existing public assets
- [x] Add a fail-closed Worker entry for API, health and real-time routes
- [x] Add automated tests for static routing and unsupported backend routes
- [x] Add request-scoped Hyperdrive PostgreSQL client adapter with guaranteed connection cleanup
- [x] Add database-backed Worker readiness check and Fetch-native `/api/auth/me`, `/api/profile`, `/api/contacts`, `/api/contacts/requests`, `/api/contacts/blocks`, `/api/users/search`, `/api/messages`, `/api/calls/config` and `/api/calls/history` handlers with session checks, same-origin protection, bounded JSON bodies and username conflict handling
- [ ] Refactor remaining authentication and social APIs to Fetch-native request handlers
- [ ] Configure a real Hyperdrive binding to the Supabase database and verify PostgreSQL transactions in the Workers runtime
- [ ] Move chat and call signaling state into SQLite-backed Durable Objects
- [ ] Add Workers integration tests and compare security behavior with the Node backend
- [ ] Complete real-device, network, privacy and operational checks before requesting deployment approval

## External dependencies (do not invent or hardcode credentials)
- SMS/OTP provider account and API credentials
- TURN service credentials or a self-hosted TURN server
- Push notification configuration (Firebase/FCM for Android)
- HTTPS domain and hosting choice (only when deployment is approved)

## Database status
- [x] Supabase PostgreSQL project connected and active
- [x] Shared OTP rate-limit table created with RLS enabled and client-role privileges revoked
- [x] Core tables created and verified: users, otp_challenges, sessions, contact_requests, messages, call_invites, user_blocks, user_reports, api_rate_limits
- [x] RLS enabled on all eight tables; no client policies granted (server-side API owns access)
- [ ] Backend hosting DATABASE_URL and OTP_HASH_SECRET configuration
- [ ] Live database + SMS integration tests

## Current status
The repository now contains OTP/session foundations, contacts and chat with authenticated live WebSocket delivery and read receipts, authenticated one-to-one call invitations, accepted-invite-only WebSocket signaling, incoming call handling, call history, and an installable PWA shell. The new UI has not yet been verified against a live PostgreSQL database or SMS provider. The project is not production-ready.
