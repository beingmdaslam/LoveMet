import { getSessionUser } from './auth.mjs';
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const UUID = /^[0-9a-f-]{36}$/i;
function json(status, body) { return new Response(JSON.stringify(body), { status, headers: HEADERS }); }
function sameOrigin(request) { try { const origin = request.headers.get('origin'); return Boolean(origin) && new URL(origin).origin === new URL(request.url).origin; } catch { return false; } }
async function readJson(request) {
 const reader = request.body?.getReader(); if (!reader) return {}; const chunks = []; let size = 0;
 try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8192) { await reader.cancel(); throw Object.assign(new Error('Request too large.'), { status: 413 }); } chunks.push(value); } } finally { reader.releaseLock(); }
 try { const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; } const body = JSON.parse(new TextDecoder().decode(raw) || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}
export async function handleModeration(request, client) {
 if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { ...HEADERS, Allow: 'POST' } });
 if (!sameOrigin(request)) return json(403, { error: 'Cross-origin request blocked.' });
 const user = await getSessionUser(request, client); if (!user) return json(401, { error: 'Sign in to continue.' });
 const pathname = new URL(request.url).pathname;
 try {
  const body = await readJson(request); const targetId = String(body.userId || '');
  if (pathname === '/api/contacts/block') {
   if (!UUID.test(targetId) || targetId === user.id) return json(400, { error: 'Provide a valid user to block.' });
   const target = await client.query('SELECT id FROM users WHERE id = $1', [targetId]); if (!target.rowCount) return json(404, { error: 'User not found.' });
   await client.query('BEGIN');
   try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(LEAST($1::text, $2::text) || ':' || GREATEST($1::text, $2::text), 0))", [user.id, targetId]);
    await client.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, targetId]);
    await client.query("UPDATE call_invites SET status = 'ended', updated_at = NOW(), ended_at = NOW() WHERE status IN ('ringing','accepted') AND ((caller_id = $1 AND callee_id = $2) OR (caller_id = $2 AND callee_id = $1))", [user.id, targetId]);
    await client.query('COMMIT'); return json(200, { ok: true });
   } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  }
  if (pathname === '/api/contacts/unblock') {
   if (!UUID.test(targetId)) return json(400, { error: 'Provide a valid user to unblock.' });
   const result = await client.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING blocked_id', [user.id, targetId]);
   return json(200, { ok: true, unblocked: result.rowCount > 0 });
  }
  if (pathname === '/api/users/report') {
   const reason = String(body.reason || ''); const details = String(body.details || '').trim();
   if (!UUID.test(targetId) || targetId === user.id || !['harassment','spam','impersonation','inappropriate','other'].includes(reason) || details.length < 1 || details.length > 1000) return json(400, { error: 'Provide a user, report reason, and details up to 1000 characters.' });
   const target = await client.query('SELECT id FROM users WHERE id = $1', [targetId]); if (!target.rowCount) return json(404, { error: 'User not found.' });
   await client.query('BEGIN');
   try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1))', [user.id]);
    const recent = await client.query("SELECT COUNT(*)::INTEGER AS total FROM user_reports WHERE reporter_id = $1 AND created_at > NOW() - INTERVAL '24 hours'", [user.id]);
    if (Number(recent.rows[0].total) >= 5) { await client.query('ROLLBACK'); return json(429, { error: 'Daily report limit reached.' }); }
    const report = await client.query('INSERT INTO user_reports (reporter_id, reported_id, reason, details) VALUES ($1, $2, $3, $4) RETURNING id, status, created_at', [user.id, targetId, reason, details]);
    await client.query('COMMIT'); return new Response(JSON.stringify({ report: report.rows[0] }), { status: 201, headers: HEADERS });
   } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  }
  return json(404, { error: 'Unknown moderation endpoint.' });
 } catch (error) { if (error.status) return json(error.status, { error: error.message }); throw error; }
}