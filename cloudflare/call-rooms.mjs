import { withDatabase } from './database.mjs';
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_SIGNAL_BYTES = 64 * 1024;
function cookieToken(request) { for (const part of String(request.headers.get('cookie') || '').split(';')) { const i = part.indexOf('='); if (i < 0 || part.slice(0, i).trim() !== 'lovemet_session') continue; try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } } return ''; }
async function tokenHash(token) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)); return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''); }
function send(ws, value) { try { if (ws.readyState === 1) ws.send(JSON.stringify(value)); } catch {} }
export class CallRooms {
 constructor(ctx, env) { this.ctx = ctx; this.env = env; }
 async fetch(request) {
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required.', { status: 426, headers: { 'Cache-Control': 'no-store' } });
  const origin = request.headers.get('Origin');
  try { if (!origin || new URL(origin).origin !== new URL(request.url).origin) return new Response('Invalid signaling origin.', { status: 403 }); } catch { return new Response('Invalid signaling origin.', { status: 403 }); }
  const token = cookieToken(request); if (!token || token.length > 200) return new Response('Sign in required.', { status: 401 });
  const hash = await tokenHash(token);
  const session = await withDatabase(this.env, client => client.query('SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() LIMIT 1', [hash]));
  if (!session.rowCount) return new Response('Sign in required.', { status: 401 });
  const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
  this.ctx.acceptWebSocket(server);
  server.serializeAttachment({ userId: session.rows[0].id, tokenHash: hash, roomId: null, joined: false, isInitiator: false });
  return new Response(null, { status: 101, webSocket: client });
 }
 async authorize(attachment, roomId) {
  return withDatabase(this.env, client => client.query("SELECT c.caller_id, c.callee_id FROM sessions s JOIN users u ON u.id = s.user_id JOIN call_invites c ON c.id = $2 WHERE s.token_hash = $1 AND s.user_id = $3 AND s.revoked_at IS NULL AND s.expires_at > NOW() AND c.status = 'accepted' AND c.expires_at > NOW() AND (c.caller_id = u.id OR c.callee_id = u.id) AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = c.caller_id AND b.blocked_id = c.callee_id) OR (b.blocker_id = c.callee_id AND b.blocked_id = c.caller_id)) LIMIT 1", [attachment.tokenHash, roomId, attachment.userId]));
 }
 async webSocketMessage(ws, raw) {
  const attachment = ws.deserializeAttachment(); if (!attachment) { ws.close(1008, 'Missing session attachment'); return; }
  const size = typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
  if (size > MAX_SIGNAL_BYTES) { ws.close(1009, 'Signaling message too large'); return; }
  let message; try { message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { send(ws, { type: 'error', message: 'Invalid message format.' }); return; }
  if (message.type === 'join') {
   const roomId = String(message.roomId || '').trim(); if (!UUID.test(roomId)) { send(ws, { type: 'error', message: 'Join using a valid accepted call invitation.' }); return; }
   let permission; try { permission = await this.authorize(attachment, roomId); } catch { ws.close(1011, 'Call authorization unavailable'); return; }
   if (!permission.rowCount) { ws.close(1008, 'Call invitation is not authorized'); return; }
   const sockets = this.ctx.getWebSockets(); const peers = sockets.filter(peer => peer !== ws && (peer.deserializeAttachment()?.joined) && peer.deserializeAttachment()?.roomId === roomId);
   if (peers.some(peer => peer.deserializeAttachment()?.userId === attachment.userId)) { send(ws, { type: 'error', message: 'This account is already connected to the call.' }); return; }
   if (peers.length >= 2) { send(ws, { type: 'error', message: 'This room is full.' }); return; }
   const reconnectKey = 'reconnect:' + roomId + ':' + attachment.userId; const reconnect = await this.ctx.storage.get(reconnectKey);
   const reconnected = Boolean(reconnect && reconnect.expiresAt > Date.now());
   if (reconnect) await this.ctx.storage.delete(reconnectKey);
   const isInitiator = reconnected ? Boolean(reconnect.isInitiator) : peers.length === 0;
   const next = { ...attachment, roomId, joined: true, isInitiator }; ws.serializeAttachment(next);
   send(ws, { type: 'joined', roomId, isInitiator, ...(reconnected ? { reconnected: true } : {}) });
   if (peers.length) { for (const peer of peers) send(peer, { type: reconnected ? 'peer-rejoined' : 'peer-joined' }); if (reconnected) send(ws, { type: 'peer-rejoined' }); }
   return;
  }
  if (!attachment.joined || !attachment.roomId || !['offer','answer','ice','hangup'].includes(message.type)) { send(ws, { type: 'error', message: 'Join a room first.' }); return; }
  let permission; try { permission = await this.authorize(attachment, attachment.roomId); } catch { ws.close(1011, 'Call authorization unavailable'); return; }
  if (!permission.rowCount) { send(ws, { type: 'error', message: 'This call is no longer authorized.' }); ws.close(1008, 'Call authorization expired'); return; }
  for (const peer of this.ctx.getWebSockets()) { const other = peer.deserializeAttachment(); if (peer !== ws && other?.joined && other.roomId === attachment.roomId) send(peer, { type: message.type, data: message.data }); }
 }
 async webSocketClose(ws, code, reason) {
  const attachment = ws.deserializeAttachment();
  if (code !== 1006) { try { ws.close(code, reason); } catch {} }
  if (!attachment?.joined || !attachment.roomId) return;
  const expiresAt = Date.now() + 25000; const key = 'reconnect:' + attachment.roomId + ':' + attachment.userId;
  await this.ctx.storage.put(key, { isInitiator: attachment.isInitiator, expiresAt });
  await this.ctx.storage.setAlarm(expiresAt);
  for (const peer of this.ctx.getWebSockets()) { const other = peer.deserializeAttachment(); if (other?.joined && other.roomId === attachment.roomId) send(peer, { type: 'peer-disconnected' }); }
 }
 async alarm() {
  const entries = await this.ctx.storage.list({ prefix: 'reconnect:' }); let nextAlarm = Infinity;
  for (const [key, value] of entries) {
   if (value.expiresAt <= Date.now()) {
    await this.ctx.storage.delete(key); const parts = key.split(':'); const roomId = parts[1];
    for (const peer of this.ctx.getWebSockets()) { const attachment = peer.deserializeAttachment(); if (attachment?.joined && attachment.roomId === roomId) send(peer, { type: 'peer-left' }); }
   } else nextAlarm = Math.min(nextAlarm, value.expiresAt);
  }
  if (Number.isFinite(nextAlarm)) await this.ctx.storage.setAlarm(nextAlarm);
 }
}