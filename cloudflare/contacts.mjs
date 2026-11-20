import { getSessionUser } from "./auth.mjs";
const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function json(status, body) { return new Response(JSON.stringify(body), { status, headers: HEADERS }); }
export async function handleContactsGet(request, client) {
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers: { ...HEADERS, Allow: "GET" } });
  const user = await getSessionUser(request, client);
  if (!user) return json(401, { error: "Sign in to continue." });
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/contacts") {
    const result = await client.query("SELECT u.id, u.username, u.display_name, u.avatar_url FROM contact_requests c JOIN users u ON u.id = CASE WHEN c.requester_id = $1 THEN c.recipient_id ELSE c.requester_id END WHERE c.status = 'accepted' AND (c.requester_id = $1 OR c.recipient_id = $1) AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1)) ORDER BY u.username NULLS LAST, u.display_name NULLS LAST", [user.id]);
    return json(200, { contacts: result.rows });
  }
  if (pathname === "/api/contacts/requests") {
    const result = await client.query("SELECT c.id, c.created_at, u.id AS user_id, u.username, u.display_name, u.avatar_url FROM contact_requests c JOIN users u ON u.id = c.requester_id WHERE c.recipient_id = $1 AND c.status = 'pending' AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1)) ORDER BY c.created_at DESC LIMIT 50", [user.id]);
    return json(200, { requests: result.rows });
  }
  return json(404, { error: "Unknown contacts endpoint." });
}