import { getSessionUser } from './auth.mjs';
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function json(status, body) { return new Response(JSON.stringify(body), { status, headers: HEADERS }); }
async function turnCredential(username, secret) {
 const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
 const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
 let binary = ''; for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte); return btoa(binary);
}
export async function handleCallsRead(request, client, env) {
 if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { ...HEADERS, Allow: 'GET' } });
 const user = await getSessionUser(request, client); if (!user) return json(401, { error: 'Sign in to continue.' });
 const pathname = new URL(request.url).pathname;
 if (pathname === '/api/calls/config') {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turnUrls = String(env?.TURN_URLS || '').split(',').map(value => value.trim()).filter(value => /^(turn|turns):/i.test(value));
  const secret = env?.TURN_SHARED_SECRET || '';
  if (turnUrls.length && secret.length >= 32) { const expiresAt = Math.floor(Date.now() / 1000) + 600; const username = expiresAt + ':' + user.id; iceServers.push({ urls: turnUrls, username, credential: await turnCredential(username, secret) }); }
  return json(200, { iceServers });
 }
 if (pathname === '/api/calls/history') {
  const result = await client.query("SELECT c.id, c.status, c.created_at, c.started_at, c.ended_at, CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END AS contact_id, u.username AS contact_username, u.display_name AS contact_display_name, CASE WHEN c.started_at IS NOT NULL AND c.ended_at IS NOT NULL THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (c.ended_at - c.started_at))))::INTEGER ELSE NULL END AS duration_seconds, (c.caller_id = $1) AS outgoing FROM call_invites c JOIN users u ON u.id = CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END WHERE c.caller_id = $1 OR c.callee_id = $1 ORDER BY c.created_at DESC LIMIT 30", [user.id]);
  return json(200, { calls: result.rows });
 }
 return json(404, { error: 'Unknown call endpoint.' });
}