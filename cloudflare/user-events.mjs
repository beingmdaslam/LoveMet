import { withDatabase } from './database.mjs';
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const MAX_EVENT_BYTES = 64 * 1024;
function cookieToken(request) { for (const part of String(request.headers.get('cookie') || '').split(';')) { const i = part.indexOf('='); if (i < 0 || part.slice(0, i).trim() !== 'lovemet_session') continue; try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } } return ''; }
async function tokenHash(token) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)); return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''); }
function send(ws, value) { try { if (ws.readyState === 1) ws.send(JSON.stringify(value)); } catch {} }
export async function publishUserEvent(env, userId, payload) {
 if (!env.USER_EVENTS || !userId || !payload || typeof payload.type !== 'string') return;
 const id = env.USER_EVENTS.idFromName(String(userId));
 const response = await env.USER_EVENTS.get(id).fetch('https://internal.lovemet/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
 if (!response.ok) throw new Error('Live event delivery failed.');
}
export class UserEvents {
 constructor(ctx, env) { this.ctx = ctx; this.env = env; }
 async fetch(request) {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/publish') {
   let raw; try { raw = await request.text(); } catch { return new Response('Invalid event.', { status: 400 }); }
   if (new TextEncoder().encode(raw).byteLength > MAX_EVENT_BYTES) return new Response('Event too large.', { status: 413 });
   let event; try { event = JSON.parse(raw); } catch { return new Response('Invalid event.', { status: 400 }); }
   if (!event || typeof event !== 'object' || Array.isArray(event) || !['message','read','call-update','contact-update'].includes(event.type)) return new Response('Unsupported event.', { status: 400 });
   let delivered = 0; for (const ws of this.ctx.getWebSockets()) { if (ws.readyState === 1) { send(ws, event); delivered += 1; } }
   return Response.json({ ok: true, delivered }, { headers: HEADERS });
  }
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required.', { status: 426, headers: HEADERS });
  const origin = request.headers.get('Origin'); try { if (!origin || new URL(origin).origin !== new URL(request.url).origin) return new Response('Invalid chat origin.', { status: 403, headers: HEADERS }); } catch { return new Response('Invalid chat origin.', { status: 403, headers: HEADERS }); }
  const token = cookieToken(request); if (!token || token.length > 200) return new Response('Sign in required.', { status: 401, headers: HEADERS });
  const hash = await tokenHash(token); let session;
  try { session = await withDatabase(this.env, client => client.query('SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() LIMIT 1', [hash])); } catch { return new Response('Chat service unavailable.', { status: 503, headers: { ...HEADERS, 'Retry-After': '60' } }); }
  if (!session.rowCount) return new Response('Sign in required.', { status: 401, headers: HEADERS });
  const sockets = this.ctx.getWebSockets(); if (sockets.length >= 5) return new Response('Too many chat connections.', { status: 429, headers: HEADERS });
  const pair = new WebSocketPair(); const [client, server] = Object.values(pair); this.ctx.acceptWebSocket(server);
  server.serializeAttachment({ userId: session.rows[0].id, tokenHash: hash, failures: 0 });
  await this.ctx.storage.setAlarm(Date.now() + 60000);
  return new Response(null, { status: 101, webSocket: client });
 }
 async webSocketMessage(ws) { try { ws.close(1008, 'Chat socket is receive-only'); } catch {} }
 async webSocketClose() {}
 async alarm() {
  let next = false;
  for (const ws of this.ctx.getWebSockets()) {
   const attachment = ws.deserializeAttachment(); if (!attachment) { ws.close(1008, 'Missing session'); continue; }
   try {
    const result = await withDatabase(this.env, client => client.query('SELECT 1 FROM sessions WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1', [attachment.tokenHash, attachment.userId]));
    if (!result.rowCount) { ws.close(1008, 'Session expired'); continue; }
    attachment.failures = 0; ws.serializeAttachment(attachment); next = true;
   } catch {
    attachment.failures = Number(attachment.failures || 0) + 1; ws.serializeAttachment(attachment);
    if (attachment.failures >= 3) ws.close(1011, 'Session verification unavailable'); else next = true;
   }
  }
  if (next && this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + 60000);
 }
}