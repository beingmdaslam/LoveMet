import { getSessionUser } from './auth.mjs';
import { publishUserEvent } from './user-events.mjs';
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function json(status, body, extra = {}) { return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } }); }
function sameOrigin(request) { try { const origin = request.headers.get('origin'); return Boolean(origin) && new URL(origin).origin === new URL(request.url).origin; } catch { return false; } }
function readCookie(request) { for (const part of String(request.headers.get('cookie') || '').split(';')) { const i = part.indexOf('='); if (i < 0 || part.slice(0, i).trim() !== 'lovemet_session') continue; try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } } return ''; }
async function getPhoneIdentity(request, client) {
 const token = readCookie(request); if (!token || token.length > 200) return null;
 const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)); const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
 const result = await client.query('SELECT u.id, u.phone_e164 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() LIMIT 1', [hash]);
 return result.rows[0] || null;
}
export async function handleAccountDelete(request, client, env) {
 if (request.method !== 'DELETE') return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { ...HEADERS, Allow: 'DELETE' } });
 if (!sameOrigin(request)) return json(403, { error: 'Cross-origin request blocked.' });
 const identity = await getPhoneIdentity(request, client); if (!identity) return json(401, { error: 'Sign in to delete your account.' });
 try {
  await client.query('BEGIN');
  const activeCalls = await client.query("SELECT caller_id, callee_id FROM call_invites WHERE status IN ('ringing','accepted') AND (caller_id = $1 OR callee_id = $1)", [identity.id]);
  await client.query('DELETE FROM otp_challenges WHERE phone_e164 = $1', [identity.phone_e164]);
  await client.query('DELETE FROM users WHERE id = $1', [identity.id]);
  await client.query('COMMIT');
  const participants = new Set([identity.id, ...activeCalls.rows.flatMap(row => [row.caller_id, row.callee_id])]);
  await Promise.all([...participants].map(userId => publishUserEvent(env, userId, { type: 'call-update' })));
  await publishUserEvent(env, identity.id, { type: 'session-ended' });
  const secure = new URL(request.url).protocol === 'https:';
  const cookie = 'lovemet_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : '');
  return json(200, { ok: true }, { 'Set-Cookie': cookie });
 } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
}