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

test("profile API does not return the private phone number", () => {
  assert.match(auth, /UPDATE users SET display_name = \$2, username = \$3[\s\S]*RETURNING id, display_name, username, avatar_url/);
  assert.doesNotMatch(auth, /UPDATE users SET display_name = \$2, username = \$3[\s\S]*RETURNING id, phone_e164/);
});

test("OTP rate limiter caps attacker-controlled key growth", () => {
  assert.match(auth, /requestLimits\.size >= 20000/);
  assert.match(auth, /if \(!entry && requestLimits\.size >= 20000\) return false/);
});

test("message history is cursor-paginated and bounded", () => {
  assert.match(social, /const beforeRaw = url\.searchParams\.get\("before"\)/);
  assert.match(social, /LIMIT 51/);
  assert.match(social, /const hasMore = result\.rows\.length > 50/);
  assert.match(social, /Invalid message cursor/);
  assert.match(fs.readFileSync(path.join(root, "public/index.html"), "utf8"), /loadOlderMessagesBtn/);
});


test("contact requests serialize unordered account pairs and reject reverse duplicates", () => {
  assert.match(social, /pg_advisory_xact_lock\(hashtextextended/);
  assert.match(social, /LEAST\(\$1::text, \$2::text\)/);
  assert.match(social, /GREATEST\(\$1::text, \$2::text\)/);
  assert.match(social, /status IN \('pending','accepted'\)/);
  assert.match(social, /await client\.query\("BEGIN"\)/);
  assert.match(social, /await client\.query\("COMMIT"\)/);
  assert.match(social, /client\.release\(\)/);
});


test("blocking and contact requests share a transaction-scoped pair lock", () => {
  const blockRoute = social.slice(social.indexOf('pathname === "/api/contacts/block"'), social.indexOf('pathname === "/api/contacts/unblock"'));
  const requestRoute = social.slice(social.indexOf('pathname === "/api/contacts/request"'), social.indexOf('pathname === "/api/contacts/respond"'));
  assert.match(blockRoute, /pg_advisory_xact_lock\(hashtextextended/);
  assert.match(blockRoute, /await client\.query\("BEGIN"\)/);
  assert.match(blockRoute, /await client\.query\("COMMIT"\)/);
  assert.match(blockRoute, /UPDATE call_invites SET status = 'ended'/);
  assert.match(requestRoute, /pg_advisory_xact_lock\(hashtextextended/);
  assert.match(requestRoute, /blockedInsideLock/);
  assert.match(requestRoute, /Contact requests are unavailable between these accounts/);
});


test("report daily limit is serialized per reporter", () => {
  const reportRoute = social.slice(social.indexOf('pathname === "/api/users/report"'), social.indexOf('pathname === "/api/contacts" && req.method === "GET"'));
  assert.match(reportRoute, /pg_advisory_xact_lock\(hashtextextended\(\$1::text, 1\)\)/);
  assert.match(reportRoute, /await client\.query\("BEGIN"\)/);
  assert.match(reportRoute, /SELECT COUNT\(\*\)::INTEGER AS total FROM user_reports/);
  assert.match(reportRoute, /await client\.query\("COMMIT"\)/);
  assert.match(reportRoute, /client\.release\(\)/);
});


test("WebSocket revalidates call authorization before relaying signaling packets", () => {
  const relay = server.slice(server.indexOf('if (["offer", "answer", "ice", "hangup"]'), server.indexOf('\n    }\n  });'));
  assert.match(relay, /message\.type !== "hangup"/);
  assert.match(relay, /status = 'accepted' AND expires_at > NOW\(\)/);
  assert.match(relay, /FROM user_blocks b/);
  assert.match(relay, /ws\.close\(1008, "Call authorization expired"\)/);
});


test("unexpected signaling socket close releases call media and invitation state", () => {
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  assert.match(html, /socket\.onclose = \(\) => \{ const wasJoined = joined; cleanup\(false\);/);
  assert.match(html, /localStream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(html, /if \(activeCallInvite\)[\s\S]*action:"end"/);
});


test("live chat WebSocket authenticates sessions and checks same-origin connections", () => {
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  assert.match(server, /path: "\/chat"/);
  assert.match(server, /origin\.host === req\.headers\.host/);
  assert.match(server, /const user = await getUser\(req\)/);
  assert.match(server, /addClient\(user\.id, ws\)/);
  assert.match(server, /Chat socket is receive-only/);
  assert.match(server, /setInterval\(async \(\) =>/);
  assert.match(server, /Session expired/);
  assert.match(server, /Too many chat connections/);
});

test("new chat messages are broadcast only to the two participants", () => {
  const social = fs.readFileSync(path.join(root, "src/social.js"), "utf8");
  const realtime = fs.readFileSync(path.join(root, "src/realtime.js"), "utf8");
  assert.match(social, /if \(!\(await isContact\(user\.id, contactId\)\)\)/);
  assert.match(social, /publishMessage\(result\.rows\[0\]\)/);
  assert.match(realtime, /\[message\.sender_id, message\.recipient_id\]/);
  assert.match(realtime, /type: "message"/);
});


test("live chat socket count is capped per account", () => {
  const realtime = fs.readFileSync(path.join(root, "src/realtime.js"), "utf8");
  assert.match(realtime, /sockets\.size >= 5/);
  assert.match(realtime, /return false/);
});


test("call invitation creation and responses notify both participants", () => {
  const social = fs.readFileSync(path.join(root, "src/social.js"), "utf8");
  const inviteRoute = social.slice(social.indexOf('pathname === "/api/calls/invite"'), social.indexOf('pathname === "/api/calls/respond"'));
  const respondRoute = social.slice(social.indexOf('pathname === "/api/calls/respond"'), social.indexOf('pathname === "/api/messages"'));
  assert.match(inviteRoute, /publishUser\(contactId, \{ type: "call-update" \}\)/);
  assert.match(inviteRoute, /publishUser\(user\.id, \{ type: "call-update" \}\)/);
  assert.match(respondRoute, /publishUser\(result\.rows\[0\]\.caller_id/);
  assert.match(respondRoute, /publishUser\(result\.rows\[0\]\.callee_id/);
});
