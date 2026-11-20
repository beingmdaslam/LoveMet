import { getSessionUser } from './auth.mjs';
import { allowRequest } from './rate-limit.mjs';
import { publishUserEvent } from './user-events.mjs';
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }; const UUID = /^[0-9a-f-]{36}$/i;
function json(status, body) { return new Response(JSON.stringify(body), { status, headers: HEADERS }); }
function sameOrigin(request) { try { const origin = request.headers.get('origin'); return Boolean(origin) && new URL(origin).origin === new URL(request.url).origin; } catch { return false; } }
async function readJson(request) { const reader = request.body?.getReader(); if (!reader) return {}; const chunks = []; let size = 0; try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); throw Object.assign(new Error('Request too large.'), { status: 413 }); } chunks.push(value); } } finally { reader.releaseLock(); } try { const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; } const body = JSON.parse(new TextDecoder().decode(raw) || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); } }
async function pairLock(client, a, b) { await client.query("SELECT pg_advisory_xact_lock(hashtextextended(LEAST($1::text, $2::text) || ':' || GREATEST($1::text, $2::text), 0))", [a, b]); }
async function lockParticipants(client, a, b) { for (const id of [String(a), String(b)].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 4))', [id]); }
async function isAcceptedContact(client, a, b) { const r = await client.query("SELECT 1 FROM contact_requests WHERE status = 'accepted' AND ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1)) AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1)) LIMIT 1", [a, b]); return r.rowCount > 0; }
export async function handleCallMutation(request, client, env) {
 if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { ...HEADERS, Allow: 'POST' } });
 if (!sameOrigin(request)) return json(403, { error: 'Cross-origin request blocked.' });
 const user = await getSessionUser(request, client); if (!user) return json(401, { error: 'Sign in to continue.' });
 const pathname = new URL(request.url).pathname;
 try {
  const body = await readJson(request);
  if (pathname === '/api/calls/invite') {
   if (!(await allowRequest(client, env?.OTP_HASH_SECRET, 'call-invite:' + user.id, 10, 3600000))) return json(429, { error: 'Too many call invitations. Try again later.' });
   const contactId = String(body.contactId || ''); if (!UUID.test(contactId) || contactId === user.id) return json(403, { error: 'Calls are available only with accepted contacts.' });
   await client.query('BEGIN');
   try {
    await pairLock(client, user.id, contactId); await lockParticipants(client, user.id, contactId);
    if (!(await isAcceptedContact(client, user.id, contactId))) { await client.query('ROLLBACK'); return json(403, { error: 'Calls are available only with accepted contacts.' }); }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 2))', [user.id]);
    await client.query("UPDATE call_invites SET status = 'ended', updated_at = NOW(), ended_at = NOW() WHERE status IN ('ringing','accepted') AND expires_at <= NOW() AND (caller_id = ANY($1::uuid[]) OR callee_id = ANY($1::uuid[]))", [[user.id, contactId]]);
    const recent = await client.query("SELECT COUNT(*)::INTEGER AS total FROM call_invites WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '1 hour'", [user.id]);
    if (Number(recent.rows[0].total) >= 20) { await client.query('ROLLBACK'); return json(429, { error: 'Call invitation limit reached. Try again later.' }); }
    const active = await client.query("SELECT id FROM call_invites WHERE status IN ('ringing','accepted') AND expires_at > NOW() AND (caller_id = ANY($1::uuid[]) OR callee_id = ANY($1::uuid[])) LIMIT 1", [[user.id, contactId]]);
    if (active.rowCount) { await client.query('ROLLBACK'); return json(409, { error: 'You or this contact is already busy with another call.' }); }
    const created = await client.query('INSERT INTO call_invites (caller_id, callee_id) VALUES ($1, $2) RETURNING id, caller_id, callee_id, status, created_at, expires_at', [user.id, contactId]);
    await client.query('COMMIT');
    await publishUserEvent(env, contactId, { type: 'call-update' });
    return new Response(JSON.stringify({ invite: created.rows[0] }), { status: 201, headers: HEADERS });
   } catch (error) { try { await client.query('ROLLBACK'); } catch {} if (error.code === '23505') return json(409, { error: 'You or this contact is already busy with another call.' }); throw error; }
  }
  if (pathname === '/api/calls/respond') {
   const inviteId = String(body.inviteId || ''); const action = String(body.action || '');
   if (!UUID.test(inviteId) || !['accept','decline','cancel','end'].includes(action)) return json(400, { error: 'Provide a valid inviteId and call action.' });
   if (action === 'accept') {
    await client.query('BEGIN');
    try {
     const invite = await client.query("SELECT caller_id, callee_id FROM call_invites WHERE id = $1 AND callee_id = $2 AND status = 'ringing' AND expires_at > NOW()", [inviteId, user.id]);
     if (!invite.rowCount) { await client.query('ROLLBACK'); return json(404, { error: 'Active call invitation not found.' }); }
     const callerId = invite.rows[0].caller_id; await pairLock(client, callerId, user.id); await lockParticipants(client, callerId, user.id);
     const active = await client.query("SELECT id FROM call_invites WHERE id <> $1 AND status IN ('ringing','accepted') AND expires_at > NOW() AND (caller_id = ANY($2::uuid[]) OR callee_id = ANY($2::uuid[])) LIMIT 1", [inviteId, [callerId, user.id]]);
     if (active.rowCount) { await client.query('ROLLBACK'); return json(409, { error: 'You or this contact is already busy with another call.' }); }
     const result = await client.query("UPDATE call_invites SET status = 'accepted', updated_at = NOW(), expires_at = NOW() + INTERVAL '4 hours', started_at = NOW() WHERE id = $1 AND callee_id = $2 AND status = 'ringing' AND expires_at > NOW() AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = call_invites.caller_id) OR (b.blocker_id = call_invites.caller_id AND b.blocked_id = $2)) RETURNING id, caller_id, callee_id, status, expires_at", [inviteId, user.id]);
     if (!result.rowCount) { await client.query('ROLLBACK'); return json(403, { error: 'This call is no longer available.' }); }
     await client.query('COMMIT');
     await Promise.all([callerId, user.id].map(userId => publishUserEvent(env, userId, { type: 'call-update' })));
     return json(200, { invite: result.rows[0] });
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
   }
   let sql; let args;
   if (action === 'decline') { sql = "UPDATE call_invites SET status = 'declined', updated_at = NOW(), ended_at = NOW() WHERE id = $1 AND callee_id = $2 AND status = 'ringing' AND expires_at > NOW() RETURNING id, caller_id, callee_id, status, expires_at"; args = [inviteId, user.id]; }
   else if (action === 'cancel') { sql = "UPDATE call_invites SET status = 'cancelled', updated_at = NOW(), ended_at = NOW() WHERE id = $1 AND caller_id = $2 AND status = 'ringing' RETURNING id, caller_id, callee_id, status"; args = [inviteId, user.id]; }
   else { sql = "UPDATE call_invites SET status = 'ended', updated_at = NOW(), ended_at = NOW() WHERE id = $1 AND (caller_id = $2 OR callee_id = $2) AND status = 'accepted' RETURNING id, caller_id, callee_id, status"; args = [inviteId, user.id]; }
   const result = await client.query(sql, args);
   if (!result.rowCount) return json(404, { error: 'Active call invitation not found.' });
   await Promise.all([result.rows[0].caller_id, result.rows[0].callee_id].map(userId => publishUserEvent(env, userId, { type: 'call-update' })));
   return json(200, { invite: result.rows[0] });
  }
  return json(404, { error: 'Unknown call mutation endpoint.' });
 } catch (error) { if (error.status) return json(error.status, { error: error.message }); throw error; }
}