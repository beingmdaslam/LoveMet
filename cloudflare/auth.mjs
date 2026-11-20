const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function readCookie(request, name) {
  for (const part of String(request.headers.get("cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ""; }
  }
  return "";
}
async function hashSessionToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}
export async function getSessionUser(request, client) {
  const token = readCookie(request, "lovemet_session");
  if (!token || token.length > 200) return null;
  const tokenHash = await hashSessionToken(token);
  const result = await client.query("SELECT u.id, u.display_name, u.username, u.avatar_url FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() LIMIT 1", [tokenHash]);
  return result.rows[0] || null;
}

export async function handleAuthMe(request, client) {
  if (request.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers: { ...JSON_HEADERS, Allow: "GET" } });
  const user = await getSessionUser(request, client);
  if (!user) return new Response(JSON.stringify({ error: "Not signed in." }), { status: 401, headers: JSON_HEADERS });
  return new Response(JSON.stringify({ user }), { status: 200, headers: JSON_HEADERS });
}
