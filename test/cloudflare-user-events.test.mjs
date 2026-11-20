import test from 'node:test';
import assert from 'node:assert/strict';
import { UserEvents } from '../cloudflare/user-events.mjs';
class Socket { constructor() { this.readyState = 1; this.sent = []; this.closed = null; } send(value) { this.sent.push(JSON.parse(value)); } close(code, reason) { this.closed = { code, reason }; this.readyState = 3; } serializeAttachment(value) { this.attachment = structuredClone(value); } deserializeAttachment() { return this.attachment && structuredClone(this.attachment); } }
function setup() { const sockets = []; const alarms = []; const ctx = { getWebSockets: () => sockets.filter(ws => ws.readyState === 1), acceptWebSocket(ws) { sockets.push(ws); }, storage: { async setAlarm(value) { alarms.push(value); } } }; return { room: new UserEvents(ctx, {}), sockets, alarms }; }
test('per-user event room broadcasts only supported server events to connected sockets', async () => {
 const { room, sockets } = setup(); const a = new Socket(); const b = new Socket(); sockets.push(a, b);
 const response = await room.fetch(new Request('https://internal.lovemet/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'message', message: { id: 'm1', body: 'hello' } }) }));
 assert.equal(response.status, 200); assert.deepEqual(a.sent, [{ type: 'message', message: { id: 'm1', body: 'hello' } }]); assert.deepEqual(b.sent, a.sent);
});
test('event room rejects unknown event types and oversized event bodies', async () => {
 const { room } = setup();
 const invalid = await room.fetch(new Request('https://internal.lovemet/publish', { method: 'POST', body: JSON.stringify({ type: 'arbitrary' }) })); assert.equal(invalid.status, 400);
 const large = await room.fetch(new Request('https://internal.lovemet/publish', { method: 'POST', body: 'x'.repeat(65537) })); assert.equal(large.status, 413);
});
test('chat sockets are receive-only and are closed if a client sends a frame', async () => {
 const { room } = setup(); const ws = new Socket(); await room.webSocketMessage(ws, 'client payload'); assert.deepEqual(ws.closed, { code: 1008, reason: 'Chat socket is receive-only' });
});
test('event room refuses non-WebSocket external requests', async () => {
 const { room } = setup(); const response = await room.fetch(new Request('https://internal.lovemet/chat')); assert.equal(response.status, 426);
});