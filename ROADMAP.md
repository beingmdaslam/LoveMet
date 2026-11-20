# LoveMet development roadmap

Deployment is intentionally postponed until the application has been implemented and tested.

## Phase 1 — Calling foundation
- [x] Responsive 1-to-1 calling screen
- [x] Room-code signaling server
- [x] Camera and microphone controls
- [x] Leave-call control
- [ ] Authenticated call invitations
- [ ] TURN server configuration and network fallback
- [ ] Reconnect handling, call timers, busy/offline states
- [ ] Camera switching and speaker/audio-route handling
- [ ] Call permission and device compatibility testing

## Phase 2 — Accounts and profiles
- [x] Phone OTP request/verification API foundation (PostgreSQL + Twilio adapter; requires deployment environment credentials and live integration test)
- [x] Persistent opaque sessions, HttpOnly cookie, logout/revocation and basic process-local rate limits (live deployment verification still pending)
- [x] Display name and username editing API + frontend UI (live database integration pending)
- [ ] Avatar upload and profile image management
- [ ] Privacy controls and block/report tools

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
- [ ] Incoming call screen and accept/decline
- [ ] Missed, incoming and outgoing call history
- [ ] Call duration and call status
- [ ] Push notifications for incoming calls/messages

## Phase 5 — Android experience
- [ ] Installable PWA baseline
- [ ] Native Android wrapper/app decision
- [ ] Background/lock-screen call behavior
- [ ] Bluetooth headset and speaker routing
- [ ] Battery, network and permission testing on real Android devices

## Phase 6 — Security, privacy and quality
- [ ] Threat model and abuse prevention
- [ ] Authentication and authorization tests
- [ ] Secure signaling and input validation
- [ ] Data retention and account deletion
- [ ] Privacy policy and terms
- [ ] Accessibility and low-bandwidth behavior
- [ ] Automated tests and production readiness review

## External dependencies (do not invent or hardcode credentials)
- SMS/OTP provider account and API credentials
- TURN service credentials or a self-hosted TURN server
- Push notification configuration (Firebase/FCM for Android)
- HTTPS domain and hosting choice (only when deployment is approved)

## Database status
- [x] Supabase PostgreSQL project connected and active
- [x] Core tables created and verified: users, otp_challenges, sessions, contact_requests, messages
- [x] RLS enabled on all five tables; no client policies granted (server-side API owns access)
- [ ] Backend hosting DATABASE_URL and OTP_HASH_SECRET configuration
- [ ] Live database + SMS integration tests

## Current status
The repository now contains the early 1-to-1 calling prototype, OTP/session backend foundations, contacts/chat APIs, and a first account/contacts/chat frontend integration. The new UI has not yet been verified against a live PostgreSQL database or SMS provider. The project is not production-ready.
