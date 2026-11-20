import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleAuthMe } from "../cloudflare/auth.mjs";
const token = "session-token-for-test";
test("Fetch auth/me returns only public user fields for a valid session", async () => {
  let queryArgs;
  const client = { async query(sql, args) { queryArgs = { sql, args }; return { rowCount: 1, rows: [{ id: "user-1", display_name: "Aslam", username: "aslam", avatar_url: null }] }; } };
  const response = await handleAuthMe(new Request("https://lovemet.example/api/auth/me", { headers: { cookie: "lovemet_session=" + token } }), client);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: { id: "user-1", display_name: "Aslam", username: "aslam", avatar_url: null } });
  assert.deepEqual(queryArgs.args, [createHash("sha256").update(token).digest("hex")]);
  assert.match(queryArgs.sql, /revoked_at IS NULL/);
  assert.match(queryArgs.sql, /expires_at > NOW\(\)/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("Fetch auth/me rejects a missing cookie without querying the database", async () => {
  let queried = false;
  const response = await handleAuthMe(new Request("https://lovemet.example/api/auth/me"), { async query() { queried = true; } });
  assert.equal(response.status, 401);
  assert.equal(queried, false);
});
test("Fetch auth/me is read-only and rejects other methods", async () => {
  let queried = false;
  const response = await handleAuthMe(new Request("https://lovemet.example/api/auth/me", { method: "POST" }), { async query() { queried = true; } });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(queried, false);
});