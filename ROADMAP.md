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
- [ ] Reconnect handling and busy/offline states
- [x] Front/rear camera switching
- [ ] Speaker/audio-route handling
- [ ] Call permission and device compatibility testing

## Phase 2 — Accounts and profiles
- [x] Phone OTP request/verification API foundation (PostgreSQL + Twilio adapter; requires deployment environment credentials and live integration test)
- [x] Persistent opaque sessions, HttpOnly cookie, logout/revocation and basic process-local rate limits (live deployment verification still pending)
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
- [x] Basic 4-second chat polling and read-receipt timestamps (push delivery still pending)
- [ ] Safe handling of attachments (if enabled)

## Phase 4 — Call management
- [x] Incoming call prompt with accept/decline
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
- [ ] Threat model and abuse prevention
- [ ] Authentication and authorization tests
- [ ] Secure signaling and input validation
- [x] Authenticated account deletion with cascading removal of contacts, messages, sessions, call history, and OTP challenges
- [ ] Formal retention schedule and deletion-request policy
- [x] Draft privacy notice and terms pages (operator/legal review and contact details required before launch)
- [ ] Accessibility and low-bandwidth behavior
- [ ] Automated tests and production readiness review

## External dependencies (do not invent or hardcode credentials)
- SMS/OTP provider account and API credentials
- TURN service credentials or a self-hosted TURN server
- Push notification configuration (Firebase/FCM for Android)
- HTTPS domain and hosting choice (only when deployment is approved)

## Database status
- [x] Supabase PostgreSQL project connected and active
- [x] Core tables created and verified: users, otp_challenges, sessions, contact_requests, messages, call_invites, user_blocks, user_reports
- [x] RLS enabled on all eight tables; no client policies granted (server-side API owns access)
- [ ] Backend hosting DATABASE_URL and OTP_HASH_SECRET configuration
- [ ] Live database + SMS integration tests

## Current status
The repository now contains OTP/session foundations, contacts and chat, authenticated one-to-one call invitations, accepted-invite-only WebSocket signaling, incoming call handling, call history, and an installable PWA shell. The new UI has not yet been verified against a live PostgreSQL database or SMS provider. The project is not production-ready.
