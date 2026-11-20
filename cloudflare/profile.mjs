import { getSessionUser } from "./auth.mjs";
const HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function json(status, body) { return new Response(JSON.stringify(body), { status, headers: HEADERS }); }
function sameOrigin(request) {
  try { const origin = request.headers.get("origin"); return Boolean(origin) && new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}
async function readJson(request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw Object.assign(new Error("Request too large."), { status: 413 }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const raw = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(raw) || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw Object.assign(new Error("Invalid JSON body."), { status: 400 }); }
}
export async function handleProfilePatch(request, client) {
  if (request.method !== "PATCH") return new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers: { ...HEADERS, Allow: "PATCH" } });
  if (!sameOrigin(request)) return json(403, { error: "Cross-origin request blocked." });
  try {
    const user = await getSessionUser(request, client);
    if (!user) return json(401, { error: "Sign in to edit your profile." });
    const body = await readJson(request);
    const displayName = body.displayName === undefined ? user.display_name : String(body.displayName).trim();
    const username = body.username === undefined ? user.username : String(body.username).trim().toLowerCase();
    if (displayName !== null && displayName !== undefined && (displayName.length < 1 || displayName.length > 40)) return json(400, { error: "Display name must be 1–40 characters." });
    if (username !== null && username !== undefined && !/^[a-z0-9_]{3,20}$/.test(username)) return json(400, { error: "Username must be 3–20 characters using lowercase letters, numbers or underscores." });
    const result = await client.query("UPDATE users SET display_name = $2, username = $3, updated_at = NOW() WHERE id = $1 RETURNING id, display_name, username, avatar_url", [user.id, displayName || null, username || null]);
    return json(200, { user: result.rows[0] });
  } catch (error) {
    if (error.status) return json(error.status, { error: error.message });
    if (error.code === "23505") return json(409, { error: "That username is already in use." });
    throw error;
  }
}