const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const social = fs.readFileSync(path.join(root, "src/social.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const auth = fs.readFileSync(path.join(root, "src/auth.js"), "utf8");

test("social routes require an authenticated session", () => {
  assert.match(social, /const user = await getUser\(req\)/);
  assert.match(social, /if \(!user\)\s*\{\s*json\(res, 401/);
});

test("messages and calls require an accepted, unblocked contact", () => {
  assert.match(social, /WHERE status = 'accepted'/);
  assert.match(social, /FROM user_blocks b[\s\S]*b\.blocker_id = \$1[\s\S]*b\.blocked_id = \$2/);
  assert.match(social, /isContact\(user\.id, contactId\)/);
});

test("WebSocket signaling checks origin, session, invitation and block state", () => {
  assert.match(server, /parsedOrigin\.host === req\.headers\.host/);
  assert.match(server, /ws\.authPromise = getUser\(req\)/);
  assert.match(server, /status = 'accepted' AND expires_at > NOW\(\)/);
  assert.match(server, /FROM user_blocks b/);
});

test("account deletion runs in a transaction and clears OTP challenges", () => {
  assert.match(auth, /pathname === "\/api\/account" && req\.method === "DELETE"/);
  assert.match(auth, /await client\.query\("BEGIN"\)/);
  assert.match(auth, /DELETE FROM otp_challenges WHERE phone_e164 = \$1/);
  assert.match(auth, /DELETE FROM users WHERE id = \$1/);
  assert.match(auth, /await client\.query\("COMMIT"\)/);
});
