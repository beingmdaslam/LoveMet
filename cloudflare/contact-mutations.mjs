import { getSessionUser } from './auth.mjs';
import { allowRequest } from './rate-limit.mjs';
import { publishUserEvent } from './user-events.mjs';
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function json(status, body) { return new Response(JSON.stringify(body), { status, headers: HEADERS }); }
function sameOrigin(request) { try { const origin = request.headers.get('origin'); return Boolean(origin) && new URL(origin).origin === new URL(request.url).origin; } catch { return false; } }
async function readJson(request) {
 const reader = request.body?.getReader(); if (!reader) return {}; const chunks = []; let size = 0;
 try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); throw Object.assign(new Error('Request too large.'), { status: 413 }); } chunks.push(value); } } finally { reader.releaseLock(); }
 try { const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; } const body = JSON.parse(new TextDecoder().decode(raw) || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}
async function pairLock(client, a, b) { await client.query("SELECT pg_advisory_xact_lock(hashtextextended(LEAST($1::text, $2::text) || ':' || GREATEST($1::text, $2::text), 0))", [a, b]); }
export async function handleContactMutation(request, client, env) {
 if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { ...HEADERS, Allow: 'POST' } });
 if (!sameOrigin(request)) return json(403, { error: 'Cross-origin request blocked.' });
 const user = await getSessionUser(request, client); if (!user) return json(401, { error: 'Sign in to continue.' });
 const pathname = new URL(request.url).pathname;
 try {
  const body = await readJson(request);
  if (pathname === '/api/contacts/request') {
   if (!(await allowRequest(client, env?.OTP_HASH_SECRET, 'contact-request:' + user.id, 20, 3600000))) return json(429, { error: 'You have sent too many contact requests. Try again later.' });
   const username = String(body.username || '').trim().toLowerCase().replace(/^@/, '');
   if (!/^[a-z0-9_]{3,20}$/.test(username)) return json(400, { error: 'Enter a valid username.' });
   const target = await client.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [username]);
   if (!target.rowCount) return json(404, { error: 'User not found.' });
   const targetId = target.rows[0].id; if (targetId === user.id) return json(400, { error: 'You cannot add yourself.' });
   const blocked = await client.query('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1', [user.id, targetId]);
   if (blocked.rowCount) return json(403, { error: 'Contact requests are unavailable between these accounts.' });
   await client.query('BEGIN');
   try {
    await pairLock(client, user.id, targetId);
    const blockedAgain = await client.query('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1', [user.id, targetId]);
    if (blockedAgain.rowCount) { await client.query('ROLLBACK'); return json(403, { error: 'Contact requests are unavailable between these accounts.' }); }
    const existing = await client.query("SELECT id, status FROM contact_requests WHERE ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1)) AND status IN ('pending','accepted') LIMIT 1", [user.id, targetId]);
    if (existing.rowCount) { await client.query('ROLLBACK'); return json(409, { error: existing.rows[0].status === 'accepted' ? 'These accounts are already contacts.' : 'A pending request already exists between these accounts.' }); }
    const created = await client.query('INSERT INTO contact_requests (requester_id, recipient_id) VALUES ($1, $2) RETURNING id, status, created_at', [user.id, targetId]);
    await client.query('COMMIT');
    await publishUserEvent(env, targetId, { type: 'contact-update' });
    return json(201, { request: created.rows[0] });
   } catch (error) { try { await client.query('ROLLBACK'); } catch {} if (error.code === '23505') return json(409, { error: 'A request already exists between these accounts.' }); throw error; }
  }
  if (pathname === '/api/contacts/respond') {
   const requestId = String(body.requestId || ''); const action = String(body.action || '');
   if (!UUID.test(requestId) || !['accept', 'decline'].includes(action)) return json(400, { error: 'Provide a valid requestId and accept or decline action.' });
   if (action === 'decline') {
    const result = await client.query("UPDATE contact_requests SET status = 'declined', updated_at = NOW() WHERE id = $1 AND recipient_id = $2 AND status = 'pending' RETURNING id, status, requester_id", [requestId, user.id]);
    if (!result.rowCount) return json(404, { error: 'Pending contact request not found.' });
    await publishUserEvent(env, result.rows[0].requester_id, { type: 'contact-update' });
    return json(200, { request: { id: result.rows[0].id, status: result.rows[0].status } });
   }
   await client.query('BEGIN');
   try {
    const pending = await client.query("SELECT requester_id FROM contact_requests WHERE id = $1 AND recipient_id = $2 AND status = 'pending'", [requestId, user.id]);
    if (!pending.rowCount) { await client.query('ROLLBACK'); return json(404, { error: 'Pending contact request not found.' }); }
    await pairLock(client, pending.rows[0].requester_id, user.id);
    const result = await client.query("UPDATE contact_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1 AND recipient_id = $2 AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = contact_requests.requester_id) OR (b.blocker_id = contact_requests.requester_id AND b.blocked_id = $2)) RETURNING id, status, requester_id", [requestId, user.id]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return json(404, { error: 'Pending contact request not found.' }); }
    await client.query('COMMIT');
    await Promise.all([publishUserEvent(env, result.rows[0].requester_id, { type: 'contact-update' }), publishUserEvent(env, user.id, { type: 'contact-update' })]);
    return json(200, { request: { id: result.rows[0].id, status: result.rows[0].status } });
   } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  }
  return json(404, { error: 'Unknown contact mutation endpoint.' });
 } catch (error) { if (error.status) return json(error.status, { error: error.message }); throw error; }
}