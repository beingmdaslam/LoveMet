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
function socket(userId, isAllowed = true) { return new Socket({ userId, tokenHash: 'hashed-' + userId, expectedRoomId: roomId, roomId: null, joined: false, isInitiator: false, allow: isAllowed }); }
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
