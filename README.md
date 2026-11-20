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
