# LoveMet

LoveMet is an early one-to-one video calling prototype.

## Included in v0.1
- Room-code based 1-to-1 call joining
- Camera and microphone permissions
- Mute microphone, turn camera off, and leave call
- WebSocket signaling for WebRTC offer/answer/ICE exchange
- Responsive mobile-first interface

## Run locally
1. Install Node.js 20 or newer.
2. Clone this repository.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000` in two browser windows or devices on the same network. For another device, configure the host firewall; camera/microphone access requires HTTPS or localhost.

## Important limitations
This is a prototype, not a production-ready calling service. It currently uses a public STUN server and has no TURN server, call history, push notifications, abuse reporting, or end-to-end identity verification. Backend foundations for phone OTP authentication, profiles, contacts and text messaging are present, with an initial account/contacts/chat interface. The Supabase PostgreSQL schema has been created and verified; the Node server still needs its secure database URL and SMS provider credentials configured before live login and messaging can be tested. Calls may fail on restrictive mobile or corporate networks until a TURN service is configured. Public deployment must use HTTPS/WSS and appropriate security, privacy, rate-limiting, and abuse protections.

Do not use this prototype for sensitive or confidential calls.


## Authentication foundation
- PostgreSQL schema is in `db/schema.sql` for users, one-time-code challenges, and revocable sessions.
- `src/security.js` provides E.164 phone validation, cryptographically generated six-digit codes, scrypt-based OTP hashing/verification, and opaque session-token helpers.
- Run the built-in security tests with `npm test` (Node.js 20+).
- Copy `.env.example` to `.env` for local configuration. Keep real secrets out of Git.
- The backend login endpoints are implemented but return service-unavailable until a real PostgreSQL connection and SMS provider credentials are configured. Do not treat this foundation as production authentication.


## Phone authentication API (backend foundation)
The server now exposes:
- `POST /api/auth/request-otp` with JSON `{"phone":"+9665XXXXXXXX"}`
- `POST /api/auth/verify-otp` with JSON `{"phone":"+9665XXXXXXXX","code":"123456"}`
- `GET /api/auth/me` to read the signed-in account
- `POST /api/auth/logout` to revoke the current session
- `PATCH /api/profile` with JSON fields `displayName` and/or `username` to update the signed-in profile

To enable it, configure PostgreSQL, run `psql "$DATABASE_URL" -f db/schema.sql`, set a strong `OTP_HASH_SECRET` (at least 32 characters), and configure Twilio credentials in the environment. Install dependencies with `npm install`. The API returns a service-unavailable response when the database is not configured; it never returns OTP codes in API responses. OTPs expire after five minutes, have a five-attempt limit, and are hashed before storage. Session cookies are HttpOnly and logout revokes the stored session. The current rate limiter is process-local and must be replaced or supplemented with a shared store before running multiple server instances. SMS costs and provider account approval may apply. Use HTTPS in any shared or production environment. This backend has not yet been integration-tested against a live database or SMS account.


## Contacts and messaging API (backend foundation)
All routes below require a valid LoveMet session cookie:
- `GET /api/users/search?username=ali` searches public usernames by prefix.
- `POST /api/contacts/request` with `{"username":"ali"}` creates a contact request.
- `GET /api/contacts/requests` lists incoming pending requests.
- `POST /api/contacts/respond` with `{"requestId":"...","action":"accept"}` or `decline` responds to an incoming request.
- `GET /api/contacts` lists accepted contacts.
- `GET /api/messages?contactId=...` reads the latest 50 messages with an accepted contact.
- `POST /api/messages` with `{"contactId":"...","message":"Hello"}` sends a text message to an accepted contact.

These are backend endpoints only; the mobile interface, real-time message delivery, pagination, read receipts, abuse controls, and live database integration tests are still outstanding.


## Supabase database status
The LoveMet Supabase project contains the five core tables: `users`, `otp_challenges`, `sessions`, `contact_requests`, and `messages`. Row-level security is enabled and direct table privileges are revoked from the public `anon` and `authenticated` roles. The intended architecture is a trusted Node backend using a private PostgreSQL connection; do not expose database credentials or service-role secrets in browser code.

Before live integration, configure these server-side environment variables in the hosting platform:
- `DATABASE_URL`: Supabase PostgreSQL connection string (use the provider-recommended pooler if direct connectivity is unavailable).
- `DATABASE_SSL=true`: when required by the selected Supabase connection method.
- `OTP_HASH_SECRET`: a unique random secret of at least 32 characters.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`: valid Twilio SMS credentials and sender.

Never commit real credentials or paste them into source files. Deployment is intentionally deferred until development and tests are complete and separately approved.
