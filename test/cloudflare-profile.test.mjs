import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleProfilePatch } from "../cloudflare/profile.mjs";
const token = "profile-session-token";
const tokenHash = createHash("sha256").update(token).digest("hex");
function clientFor(updateResult = { rows: [{ id: "u1", display_name: "Aslam", username: "aslam_1", avatar_url: null }] }) {
  const calls = [];
  return { calls, async query(sql, args) { calls.push({ sql, args }); if (sql.startsWith("SELECT")) return { rowCount: 1, rows: [{ id: "u1", display_name: "Old", username: "oldname", avatar_url: null }] }; return updateResult; } };
}
test("profile PATCH authenticates the session and updates only allowed public fields", async () => {
  const client = clientFor();
  const request = new Request("https://lovemet.example/api/profile", { method: "PATCH", headers: { origin: "https://lovemet.example", cookie: "lovemet_session=" + token, "content-type": "application/json" }, body: JSON.stringify({ displayName: "Aslam", username: "Aslam_1" }) });
  const response = await handleProfilePatch(request, client);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: { id: "u1", display_name: "Aslam", username: "aslam_1", avatar_url: null } });
  assert.deepEqual(client.calls[0].args, [tokenHash]);
  assert.deepEqual(client.calls[1].args, ["u1", "Aslam", "aslam_1"]);
  assert.match(client.calls[1].sql, /RETURNING id, display_name, username, avatar_url/);
});
test("profile PATCH rejects cross-origin requests before database access", async () => {
  const client = clientFor();
  const response = await handleProfilePatch(new Request("https://lovemet.example/api/profile", { method: "PATCH", headers: { origin: "https://attacker.example", cookie: "lovemet_session=" + token }, body: "{}" }), client);
  assert.equal(response.status, 403);
  assert.equal(client.calls.length, 0);
});
test("profile PATCH validates username format and reports uniqueness conflicts", async () => {
  const invalidClient = clientFor();
  const invalid = await handleProfilePatch(new Request("https://lovemet.example/api/profile", { method: "PATCH", headers: { origin: "https://lovemet.example", cookie: "lovemet_session=" + token }, body: JSON.stringify({ username: "bad name" }) }), invalidClient);
  assert.equal(invalid.status, 400);
  assert.equal(invalidClient.calls.length, 1);
  const duplicateClient = clientFor();
  duplicateClient.query = async (sql, args) => { duplicateClient.calls.push({ sql, args }); if (sql.startsWith("SELECT")) return { rowCount: 1, rows: [{ id: "u1", display_name: "Old", username: "oldname", avatar_url: null }] }; const error = new Error("duplicate"); error.code = "23505"; throw error; };
  const duplicate = await handleProfilePatch(new Request("https://lovemet.example/api/profile", { method: "PATCH", headers: { origin: "https://lovemet.example", cookie: "lovemet_session=" + token }, body: JSON.stringify({ username: "takenname" }) }), duplicateClient);
  assert.equal(duplicate.status, 409);
});
test("profile PATCH enforces an 8 KiB request body limit", async () => {
  const client = clientFor();
  const response = await handleProfilePatch(new Request("https://lovemet.example/api/profile", { method: "PATCH", headers: { origin: "https://lovemet.example", cookie: "lovemet_session=" + token }, body: JSON.stringify({ displayName: "x".repeat(9000) }) }), client);
  assert.equal(response.status, 413);
});