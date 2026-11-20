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
  const expectedRoomId = new URL(request.url).searchParams.get('roomId') || ''; if (!UUID.test(expectedRoomId)) return new Response('A valid call invitation is required.', { status: 400 });
  const token = cookieToken(request); if (!token || token.length > 200) return new Response('Sign in required.', { status: 401 });
  const hash = await tokenHash(token);
  let session;
  try { session = await withDatabase(this.env, client => client.query('SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() LIMIT 1', [hash])); }
  catch { return new Response('Signaling service unavailable.', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } }); }
  if (!session.rowCount) return new Response('Sign in required.', { status: 401 });
  const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
  this.ctx.acceptWebSocket(server);
  await this.ctx.storage.setAlarm(Date.now() + 60000);
  server.serializeAttachment({ userId: session.rows[0].id, tokenHash: hash, expectedRoomId, roomId: null, joined: false, isInitiator: false });
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
   if (attachment.joined) { send(ws, { type: 'error', message: 'You are already in a room.' }); return; }
   const roomId = String(message.roomId || '').trim(); if (!UUID.test(roomId) || roomId !== attachment.expectedRoomId) { send(ws, { type: 'error', message: 'Join using a valid accepted call invitation.' }); return; }
   let permission; try { permission = await this.authorize(attachment, roomId); } catch { ws.close(1011, 'Call authorization unavailable'); return; }
   if (!permission.rowCount) { ws.close(1008, 'Call invitation is not authorized'); return; }
   const memberKey = 'member:' + roomId + ':' + attachment.userId;
   const reconnectKey = 'reconnect:' + roomId + ':' + attachment.userId;
   const membership = await this.ctx.storage.transaction(async txn => {
    const entries = await txn.list({ prefix: 'member:' + roomId + ':' });
    const existing = await txn.get(memberKey);
    if (existing?.connected) return { error: 'duplicate' };
    const reconnected = Boolean(existing && !existing.connected && existing.expiresAt > Date.now());
    const others = [...entries.entries()].filter(([key, value]) => key !== memberKey && (value.connected || value.expiresAt > Date.now()));
    if (others.length >= 2) return { error: 'full' };
    if (existing && !reconnected) await txn.delete(memberKey);
    const isInitiator = reconnected ? Boolean(existing.isInitiator) : others.length === 0;
    await txn.put(memberKey, { userId: attachment.userId, isInitiator, connected: true, expiresAt: null });
    if (reconnected) await txn.delete(reconnectKey);
    return { isInitiator, reconnected };
   });
   if (membership.error === 'duplicate') { send(ws, { type: 'error', message: 'This account is already connected to the call.' }); return; }
   if (membership.error === 'full') { send(ws, { type: 'error', message: 'This room is full.' }); return; }
   const peers = this.ctx.getWebSockets().filter(peer => peer !== ws && peer.deserializeAttachment()?.joined && peer.deserializeAttachment()?.roomId === roomId);
   const isInitiator = membership.isInitiator;
   ws.serializeAttachment({ ...attachment, roomId, joined: true, isInitiator });
   send(ws, { type: 'joined', roomId, isInitiator, ...(membership.reconnected ? { reconnected: true } : {}) });
   if (peers.length) { for (const peer of peers) send(peer, { type: membership.reconnected ? 'peer-rejoined' : 'peer-joined' }); if (membership.reconnected) send(ws, { type: 'peer-rejoined' }); }
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
  const expiresAt = Date.now() + 25000;
  const memberKey = 'member:' + attachment.roomId + ':' + attachment.userId;
  const reconnectKey = 'reconnect:' + attachment.roomId + ':' + attachment.userId;
  await this.ctx.storage.transaction(async txn => {
   const member = await txn.get(memberKey);
   await txn.put(memberKey, { userId: attachment.userId, isInitiator: attachment.isInitiator, connected: false, expiresAt });
   await txn.put(reconnectKey, { isInitiator: member?.isInitiator ?? attachment.isInitiator, expiresAt });
  });
  await this.ctx.storage.setAlarm(expiresAt);
  for (const peer of this.ctx.getWebSockets()) { const other = peer.deserializeAttachment(); if (other?.joined && other.roomId === attachment.roomId) send(peer, { type: 'peer-disconnected' }); }
 }
 async alarm() {
  const now = Date.now();
  const entries = await this.ctx.storage.list({ prefix: 'reconnect:' });
  let nextAlarm = Infinity;
  for (const [key, value] of entries) {
   if (value.expiresAt <= now) {
    await this.ctx.storage.delete(key);
    const parts = key.split(':');
    const roomId = parts[1];
    await this.ctx.storage.delete('member:' + roomId + ':' + parts[2]);
    for (const peer of this.ctx.getWebSockets()) {
     const attachment = peer.deserializeAttachment();
     if (attachment?.joined && attachment.roomId === roomId) send(peer, { type: 'peer-left' });
    }
   } else nextAlarm = Math.min(nextAlarm, value.expiresAt);
  }
  let hasSockets = false;
  for (const ws of this.ctx.getWebSockets()) {
   const attachment = ws.deserializeAttachment();
   if (!attachment) { ws.close(1008, 'Missing session'); continue; }
   try {
    const permission = attachment.joined && attachment.roomId
     ? await this.authorize(attachment, attachment.roomId)
     : await withDatabase(this.env, client => client.query('SELECT 1 FROM sessions WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1', [attachment.tokenHash, attachment.userId]));
    if (!permission.rowCount) { ws.close(1008, 'Session or call invitation expired'); continue; }
    attachment.authFailures = 0;
    ws.serializeAttachment(attachment);
    hasSockets = true;
   } catch {
    attachment.authFailures = Number(attachment.authFailures || 0) + 1;
    ws.serializeAttachment(attachment);
    if (attachment.authFailures >= 3) ws.close(1011, 'Call authorization unavailable');
    else hasSockets = true;
   }
  }
  if (hasSockets) nextAlarm = Math.min(nextAlarm, now + 60000);
  if (Number.isFinite(nextAlarm)) await this.ctx.storage.setAlarm(nextAlarm);
 }
}