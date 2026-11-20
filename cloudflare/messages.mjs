import { getSessionUser } from './auth.mjs';
import { allowRequest } from './rate-limit.mjs';
import { publishUserEvent } from './user-events.mjs';
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function json(status, body) { return new Response(JSON.stringify(body), { status, headers: HEADERS }); }
function sameOrigin(request) { try { const origin = request.headers.get('origin'); return Boolean(origin) && new URL(origin).origin === new URL(request.url).origin; } catch { return false; } }
async function readJson(request) {
 const reader = request.body?.getReader(); if (!reader) return {};
 const chunks = []; let size = 0;
 try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); throw Object.assign(new Error('Request too large.'), { status: 413 }); } chunks.push(value); } } finally { reader.releaseLock(); }
 try { const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; } const body = JSON.parse(new TextDecoder().decode(raw) || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}
async function isContact(client, userId, contactId) {
 const result = await client.query("SELECT 1 FROM contact_requests WHERE status = 'accepted' AND ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1)) AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1)) LIMIT 1", [userId, contactId]);
 return result.rowCount > 0;
}
export async function handleMessages(request, client, env) {
 const method = request.method;
 if (!['GET', 'POST'].includes(method)) return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { ...HEADERS, Allow: 'GET, POST' } });
 if (method === 'POST' && !sameOrigin(request)) return json(403, { error: 'Cross-origin request blocked.' });
 const user = await getSessionUser(request, client);
 if (!user) return json(401, { error: 'Sign in to continue.' });
 if (method === 'GET') {
  const url = new URL(request.url); const contactId = String(url.searchParams.get('contactId') || '');
  if (!UUID.test(contactId) || !(await isContact(client, user.id, contactId))) return json(403, { error: 'Messages are available only with accepted contacts.' });
  const beforeRaw = url.searchParams.get('before'); const beforeId = url.searchParams.get('beforeId'); let before = null;
  if (beforeRaw !== null || beforeId !== null) { const parsed = new Date(beforeRaw || ''); if (!Number.isFinite(parsed.getTime()) || !UUID.test(beforeId || '')) return json(400, { error: 'Invalid message cursor.' }); before = parsed.toISOString(); }
  const read = await client.query('UPDATE messages SET delivered_at = COALESCE(delivered_at, NOW()), read_at = NOW() WHERE sender_id = $2 AND recipient_id = $1 AND read_at IS NULL RETURNING id, read_at', [user.id, contactId]);
  if (read.rowCount) await publishUserEvent(env, contactId, { type: 'read', contactId: user.id, messageIds: read.rows.map(row => row.id), readAt: read.rows[0].read_at });
  const result = await client.query('SELECT id, sender_id, recipient_id, body, created_at, delivered_at, read_at FROM messages WHERE ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)) AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid)) ORDER BY created_at DESC, id DESC LIMIT 51', [user.id, contactId, before, beforeId]);
  const hasMore = result.rows.length > 50; const messages = result.rows.slice(0, 50).reverse();
  return json(200, { messages, hasMore });
 }
 if (!(await allowRequest(client, env?.OTP_HASH_SECRET, 'message-send:' + user.id, 60, 60000))) return json(429, { error: 'You are sending messages too quickly. Try again shortly.' });
 const body = await readJson(request); const contactId = String(body.contactId || ''); const message = String(body.message || '').trim();
 if (!UUID.test(contactId) || message.length < 1 || message.length > 4000) return json(400, { error: 'Provide a contact and a message of 1–4000 characters.' });
 if (!(await isContact(client, user.id, contactId))) return json(403, { error: 'You can message accepted contacts only.' });
 try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended(LEAST($1::text, $2::text) || ':' || GREATEST($1::text, $2::text), 0))", [user.id, contactId]);
  if (!(await isContact(client, user.id, contactId))) { await client.query('ROLLBACK'); return json(403, { error: 'You can message accepted contacts only.' }); }
  const result = await client.query('INSERT INTO messages (sender_id, recipient_id, body) VALUES ($1, $2, $3) RETURNING id, sender_id, recipient_id, body, created_at, delivered_at, read_at', [user.id, contactId, message]);
  await client.query('COMMIT');
  await publishUserEvent(env, contactId, { type: 'message', message: result.rows[0] });
  return json(201, { message: result.rows[0] });
 } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
}