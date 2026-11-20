import { getSessionUser } from './auth.mjs';
import { allowRequest } from './rate-limit.mjs';
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function json(status, body) { return new Response(JSON.stringify(body), { status, headers: HEADERS }); }
export async function handleUserLookup(request, client, env) {
 if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { ...HEADERS, Allow: 'GET' } });
 const user = await getSessionUser(request, client);
 if (!user) return json(401, { error: 'Sign in to continue.' });
 const pathname = new URL(request.url).pathname;
 if (pathname === '/api/users/search') {
  if (!(await allowRequest(client, env?.OTP_HASH_SECRET, 'search:' + user.id, 60, 60000))) return json(429, { error: 'Search limit reached. Try again shortly.' });
  const term = String(new URL(request.url).searchParams.get('username') || '').trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9_]{3,20}$/.test(term)) return json(400, { error: 'Enter a username with 3–20 letters, numbers or underscores.' });
  const result = await client.query('SELECT id, username, display_name, avatar_url FROM users WHERE username LIKE $1 AND id <> $2 AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = users.id) OR (b.blocker_id = users.id AND b.blocked_id = $2)) LIMIT 10', [term + '%', user.id]);
  return json(200, { users: result.rows });
 }
 if (pathname === '/api/contacts/blocks') {
  const result = await client.query('SELECT u.id, u.username, u.display_name, b.created_at FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY b.created_at DESC LIMIT 100', [user.id]);
  return json(200, { blocks: result.rows });
 }
 return json(404, { error: 'Unknown user lookup endpoint.' });
}