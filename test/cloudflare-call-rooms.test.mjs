import test from 'node:test';
import assert from 'node:assert/strict';
import { CallRooms } from '../cloudflare/call-rooms.mjs';
class Socket { constructor(attachment) { this.attachment = attachment; this.readyState = 1; this.sent = []; this.closed = null; } serializeAttachment(value) { this.attachment = structuredClone(value); } deserializeAttachment() { return this.attachment && structuredClone(this.attachment); } send(value) { this.sent.push(JSON.parse(value)); } close(code, reason) { this.closed = { code, reason }; this.readyState = 3; } }
function setup() {
 const sockets = []; const values = new Map(); let alarm = null;
 let transactionGate = Promise.resolve();
 const storage = {
  async get(key) { return values.get(key); },
  async put(key, value) { values.set(key, structuredClone(value)); },
  async delete(key) { values.delete(key); },
  async setAlarm(value) { alarm = value; },
  async getAlarm() { return alarm; },
  async list({ prefix }) { return new Map([...values.entries()].filter(([key]) => key.startsWith(prefix))); },
  transaction(callback) {
   const run = transactionGate.then(() => callback({
    async get(key) { return values.get(key); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { values.delete(key); },
    async list({ prefix }) { return new Map([...values.entries()].filter(([key]) => key.startsWith(prefix))); }
   }));
   transactionGate = run.catch(() => {});
   return run;
  }
 };
 const ctx = { getWebSockets: () => sockets.filter(socket => socket.readyState === 1), acceptWebSocket(socket) { sockets.push(socket); }, storage };
 const room = new CallRooms(ctx, {}); room.authorize = async (attachment, roomId) => ({ rowCount: attachment.allow === false ? 0 : 1, rows: [{ caller_id: 'u1', callee_id: 'u2' }] });
 return { room, ctx, sockets, values, get alarm() { return alarm; } };
}
const roomId = '11111111-1111-4111-8111-111111111111';
let socketCounter = 0;
function socket(userId, isAllowed = true) { return new Socket({ userId, tokenHash: 'hashed-' + userId, socketId: 'socket-' + (++socketCounter), expectedRoomId: roomId, roomId: null, joined: false, isInitiator: false, allow: isAllowed }); }
test('call room admits only authorized participants and relays negotiation messages', async () => {
 const { room, ctx, sockets } = setup(); const a = socket('u1'); const b = socket('u2'); sockets.push(a, b);
 await room.webSocketMessage(a, JSON.stringify({ type: 'join', roomId }));
 assert.deepEqual(a.sent[0], { type: 'joined', roomId, isInitiator: true });
 await room.webSocketMessage(b, JSON.stringify({ type: 'join', roomId }));
 assert.deepEqual(b.sent[0], { type: 'joined', roomId, isInitiator: false }); assert.ok(a.sent.some(message => message.type === 'peer-joined'));
 await room.webSocketMessage(a, JSON.stringify({ type: 'offer', data: { sdp: 'offer' } }));
 assert.deepEqual(b.sent.at(-1), { type: 'offer', data: { sdp: 'offer' } });
});
test('call room rejects an invitation when the database authorization check fails', async () => {
 const { room, sockets } = setup(); const a = socket('u1', false); sockets.push(a);
 await room.webSocketMessage(a, JSON.stringify({ type: 'join', roomId }));
 assert.equal(a.closed.code, 1008);
});
test('call room preserves initiator identity through the 25-second reconnect grace period', async () => {
 const { room, ctx, sockets, values } = setup(); const a = socket('u1'); const b = socket('u2'); sockets.push(a, b);
 await room.webSocketMessage(a, JSON.stringify({ type: 'join', roomId })); await room.webSocketMessage(b, JSON.stringify({ type: 'join', roomId }));
 a.readyState = 3; await room.webSocketClose(a, 1006, 'network lost');
 assert.ok(b.sent.some(message => message.type === 'peer-disconnected'));
 const key = 'reconnect:' + roomId + ':u1'; assert.ok(values.has(key)); assert.deepEqual(ctx.getWebSockets().map(item => item.deserializeAttachment().userId), ['u2']);
 const rejoined = socket('u1'); sockets.push(rejoined); await room.webSocketMessage(rejoined, JSON.stringify({ type: 'join', roomId }));
 assert.deepEqual(rejoined.sent[0], { type: 'joined', roomId, isInitiator: true, reconnected: true });
 assert.ok(b.sent.some(message => message.type === 'peer-rejoined')); assert.equal(values.has(key), false);
});
test('call room expires reconnect placeholders and notifies remaining peer', async () => {
 const { room, ctx, sockets, values } = setup(); const peer = socket('u2'); peer.serializeAttachment({ ...peer.deserializeAttachment(), joined: true, roomId }); sockets.push(peer);
 values.set('reconnect:' + roomId + ':u1', { isInitiator: true, expiresAt: Date.now() - 1 });
 await room.alarm(); assert.ok(peer.sent.some(message => message.type === 'peer-left')); assert.equal(values.size, 0);
});
test('call room alarm closes a connected socket after session or invitation revocation', async () => {
 const { room, sockets } = setup();
 const peer = socket('u1', false);
 peer.serializeAttachment({ ...peer.deserializeAttachment(), joined: true, roomId });
 sockets.push(peer);
 await room.alarm();
 assert.equal(peer.closed.code, 1008);
});
test('call room alarm tolerates two transient authorization failures before closing', async () => {
 const { room, sockets } = setup();
 const peer = socket('u1');
 peer.serializeAttachment({ ...peer.deserializeAttachment(), joined: true, roomId });
 sockets.push(peer);
 room.authorize = async () => { throw new Error('temporary database outage'); };
 await room.alarm();
 assert.equal(peer.closed, null);
 await room.alarm();
 assert.equal(peer.closed, null);
 await room.alarm();
 assert.equal(peer.closed.code, 1011);
});

test('concurrent room joins cannot admit duplicate accounts or a third participant', async () => {
 const { room, sockets } = setup();
 const a1 = socket('u1'); const a2 = socket('u1'); const b = socket('u2'); const c = socket('u3');
 sockets.push(a1, a2, b, c);
 await Promise.all([
  room.webSocketMessage(a1, JSON.stringify({ type: 'join', roomId })),
  room.webSocketMessage(a2, JSON.stringify({ type: 'join', roomId })),
  room.webSocketMessage(b, JSON.stringify({ type: 'join', roomId })),
  room.webSocketMessage(c, JSON.stringify({ type: 'join', roomId }))
 ]);
 const joined = sockets.filter(ws => ws.deserializeAttachment()?.joined);
 assert.equal(joined.length, 2);
 assert.equal(joined.filter(ws => ws.deserializeAttachment().userId === 'u1').length, 1);
 assert.ok(a2.sent.some(message => message.type === 'error') || a1.sent.some(message => message.type === 'error'));
 assert.ok(c.sent.some(message => message.type === 'error'));
});

test('a delayed close event from an old socket cannot overwrite a rejoined participant', async () => {
 const { room, sockets, values } = setup();
 const oldSocket = socket('u1'); sockets.push(oldSocket);
 await room.webSocketMessage(oldSocket, JSON.stringify({ type: 'join', roomId }));
 oldSocket.readyState = 3;
 await room.webSocketClose(oldSocket, 1006, 'network lost');
 const newSocket = socket('u1'); sockets.push(newSocket);
 await room.webSocketMessage(newSocket, JSON.stringify({ type: 'join', roomId }));
 await room.webSocketClose(oldSocket, 1006, 'late close callback');
 const member = values.get('member:' + roomId + ':u1');
 assert.equal(member.connected, true);
 assert.equal(member.socketId, newSocket.deserializeAttachment().socketId);
});

test('call room limits signaling frames per socket without blocking normal ICE traffic', async () => {
 const { room, sockets } = setup();
 const peer = socket('u1'); sockets.push(peer);
 await room.webSocketMessage(peer, JSON.stringify({ type: 'join', roomId }));
 for (let i = 0; i < 299; i++) await room.webSocketMessage(peer, JSON.stringify({ type: 'ice', data: { candidate: 'candidate-' + i } }));
 assert.equal(peer.closed, null);
 await room.webSocketMessage(peer, JSON.stringify({ type: 'ice', data: { candidate: 'overflow' } }));
 assert.equal(peer.closed.code, 1008);
 assert.equal(peer.closed.reason, 'Signaling rate limit exceeded');
});

test('call room closes signaling frames larger than 64 KiB', async () => {
 const { room } = setup();
 const peer = socket('u1');
 await room.webSocketMessage(peer, 'x'.repeat(65537));
 assert.equal(peer.closed.code, 1009);
 assert.equal(peer.closed.reason, 'Signaling message too large');
});

test('call room permits a teardown hangup after the invitation authorization has ended', async () => {
 const { room, sockets } = setup();
 const a = socket('u1'); const b = socket('u2'); sockets.push(a, b);
 await room.webSocketMessage(a, JSON.stringify({ type: 'join', roomId }));
 await room.webSocketMessage(b, JSON.stringify({ type: 'join', roomId }));
 room.authorize = async () => ({ rowCount: 0, rows: [] });
 await room.webSocketMessage(a, JSON.stringify({ type: 'hangup' }));
 assert.deepEqual(b.sent.at(-1), { type: 'hangup' });
 assert.equal(a.closed, null);
});

test('call room keeps the earliest reconnect expiry alarm when both peers disconnect', async () => {
 const state = setup();
 const { room, sockets, values } = state;
 const a = socket('u1'); const b = socket('u2'); sockets.push(a, b);
 await room.webSocketMessage(a, JSON.stringify({ type: 'join', roomId }));
 await room.webSocketMessage(b, JSON.stringify({ type: 'join', roomId }));
 a.readyState = 3; await room.webSocketClose(a, 1006, 'first network loss');
 const firstAlarm = state.alarm;
 b.readyState = 3; await room.webSocketClose(b, 1006, 'second network loss');
 assert.equal(state.alarm, firstAlarm);
 assert.ok(values.has('reconnect:' + roomId + ':u1'));
 assert.ok(values.has('reconnect:' + roomId + ':u2'));
});

test('call room alarm removes only expired reconnect members and schedules the next expiry', async () => {
 const state = setup();
 const { room, values } = state;
 const expiredAt = Date.now() - 1;
 const laterExpiry = Date.now() + 15000;
 values.set('reconnect:' + roomId + ':u1', { isInitiator: true, expiresAt: expiredAt });
 values.set('member:' + roomId + ':u1', { userId: 'u1', connected: false, expiresAt: expiredAt });
 values.set('reconnect:' + roomId + ':u2', { isInitiator: false, expiresAt: laterExpiry });
 values.set('member:' + roomId + ':u2', { userId: 'u2', connected: false, expiresAt: laterExpiry });
 await room.alarm();
 assert.equal(values.has('reconnect:' + roomId + ':u1'), false);
 assert.equal(values.has('member:' + roomId + ':u1'), false);
 assert.equal(values.has('reconnect:' + roomId + ':u2'), true);
 assert.equal(values.has('member:' + roomId + ':u2'), true);
 assert.equal(state.alarm, laterExpiry);
});

test('call room rejects signaling requests without a WebSocket upgrade', async () => {
 const { room } = setup();
 const response = await room.fetch(new Request('https://lovemet.example/signal?roomId=' + roomId));
 assert.equal(response.status, 426);
});

test('call room rejects missing, malformed, or cross-origin signaling handshakes before accepting sockets', async () => {
 const { room, sockets } = setup();
 const missingOrigin = await room.fetch(new Request('https://lovemet.example/signal?roomId=' + roomId, { headers: { Upgrade: 'websocket' } }));
 assert.equal(missingOrigin.status, 403);
 const crossOrigin = await room.fetch(new Request('https://lovemet.example/signal?roomId=' + roomId, { headers: { Upgrade: 'websocket', Origin: 'https://attacker.example' } }));
 assert.equal(crossOrigin.status, 403);
 const malformedRoom = await room.fetch(new Request('https://lovemet.example/signal?roomId=bad', { headers: { Upgrade: 'websocket', Origin: 'https://lovemet.example' } }));
 assert.equal(malformedRoom.status, 400);
 assert.equal(sockets.length, 0);
});
test('call room closes authenticated sockets that never join within two minutes', async () => {
 const { room, sockets } = setup();
 const peer = socket('u1');
 peer.serializeAttachment({ ...peer.deserializeAttachment(), connectedAt: Date.now() - 120001, joined: false, roomId: null });
 sockets.push(peer);
 await room.alarm();
 assert.deepEqual(peer.closed, { code: 1008, reason: 'Call join timed out' });
});

test('call room refuses non-participants before allocating a WebSocket', async () => {
 const { room, sockets } = setup();
 room.database = async (_env, callback) => callback({ query: async () => ({ rowCount: 1, rows: [{ id: 'u3' }] }) });
 room.authorize = async () => ({ rowCount: 0, rows: [] });
 const response = await room.fetch(new Request('https://lovemet.example/signal?roomId=' + roomId, {
  headers: { Upgrade: 'websocket', Origin: 'https://lovemet.example', Cookie: 'lovemet_session=valid-session' }
 }));
 assert.equal(response.status, 403);
 assert.equal(sockets.length, 0);
});

test('call room rejects UUID-shaped values that are not canonical UUIDs', async () => {
 const { room, sockets } = setup();
 const malformed = '111111111111111111111111111111111111';
 const response = await room.fetch(new Request('https://lovemet.example/signal?roomId=' + malformed, {
  headers: { Upgrade: 'websocket', Origin: 'https://lovemet.example' }
 }));
 assert.equal(response.status, 400);
 assert.equal(sockets.length, 0);
});
