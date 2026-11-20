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
This is a prototype, not a production-ready calling service. It currently uses a public STUN server and has no TURN server, authentication, OTP, user profiles, contacts, chat, call history, push notifications, abuse reporting, or end-to-end identity verification. Calls may fail on restrictive mobile or corporate networks until a TURN service is configured. Public deployment must use HTTPS/WSS and appropriate security, privacy, rate-limiting, and abuse protections.

Do not use this prototype for sensitive or confidential calls.


## Authentication foundation (in progress)
- PostgreSQL schema is in `db/schema.sql` for users, one-time-code challenges, and revocable sessions.
- `src/security.js` provides E.164 phone validation, cryptographically generated six-digit codes, scrypt-based OTP hashing/verification, and opaque session-token helpers.
- Run the built-in security tests with `npm test` (Node.js 20+).
- Copy `.env.example` to `.env` for local configuration. Keep real secrets out of Git.
- SMS delivery and database-backed login endpoints are not active yet. A real SMS provider and PostgreSQL connection must be configured before phone verification can be used. Do not treat generated OTPs or this foundation as production authentication.


## Phone authentication API (backend foundation)
The server now exposes:
- `POST /api/auth/request-otp` with JSON `{"phone":"+9665XXXXXXXX"}`
- `POST /api/auth/verify-otp` with JSON `{"phone":"+9665XXXXXXXX","code":"123456"}`
- `GET /api/auth/me` to read the signed-in account
- `POST /api/auth/logout` to revoke the current session
- `PATCH /api/profile` with JSON fields `displayName` and/or `username` to update the signed-in profile

To enable it, configure PostgreSQL, run `psql "$DATABASE_URL" -f db/schema.sql`, set a strong `OTP_HASH_SECRET` (at least 32 characters), and configure Twilio credentials in the environment. Install dependencies with `npm install`. The API returns a service-unavailable response when the database is not configured; it never returns OTP codes in API responses. OTPs expire after five minutes, have a five-attempt limit, and are hashed before storage. Session cookies are HttpOnly and logout revokes the stored session. The current rate limiter is process-local and must be replaced or supplemented with a shared store before running multiple server instances. SMS costs and provider account approval may apply. Use HTTPS in any shared or production environment. This backend has not yet been integration-tested against a live database or SMS account.
