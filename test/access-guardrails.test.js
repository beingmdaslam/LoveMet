const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const social = fs.readFileSync(path.join(root, "src/social.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const auth = fs.readFileSync(path.join(root, "src/auth.js"), "utf8");
const frontend = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

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


test("call invitations share the block pair lock and serialize per-caller quota", () => {
  const route = social.slice(social.indexOf('pathname === "/api/calls/invite"'), social.indexOf('pathname === "/api/calls/respond"'));
  assert.match(route, /await client\.query\("BEGIN"\)/);
  assert.match(route, /LEAST\(\$1::text, \$2::text\)/);
  assert.match(route, /GREATEST\(\$1::text, \$2::text\)/);
  assert.match(route, /lockCallParticipants\(client, user\.id, contactId\)/);
  assert.match(route, /caller_id = ANY\(\$1::uuid\[\]\) OR callee_id = ANY\(\$1::uuid\[\]\)/);
  assert.match(route, /You or this contact is already busy with another call/);
  assert.match(route, /FROM user_blocks b/);
  assert.match(route, /hashtextextended\(\$1::text, 2\)/);
  assert.match(route, /SELECT COUNT\(\*\)::INTEGER AS total FROM call_invites/);
  assert.match(route, /await client\.query\("COMMIT"\)/);
  assert.match(route, /client\.release\(\)/);
});


test("accepting a call invitation shares the block pair lock", () => {
  const route = social.slice(social.indexOf('pathname === "/api/calls/respond"'), social.indexOf('pathname === "/api/messages" && req.method === "GET"'));
  const accept = route.slice(route.indexOf('if (action === "accept")'), route.indexOf('} else if (action === "decline")'));
  assert.match(accept, /await client\.query\("BEGIN"\)/);
  assert.match(accept, /SELECT caller_id, callee_id FROM call_invites/);
  assert.match(accept, /pg_advisory_xact_lock\(hashtextextended/);
  assert.match(accept, /lockCallParticipants\(client, callerId, user\.id\)/);
  assert.match(accept, /id <> \$1 AND status IN \('ringing','accepted'\)/);
  assert.match(accept, /You or this contact is already busy with another call/);
  assert.match(accept, /FROM user_blocks b/);
  assert.match(accept, /await client\.query\("COMMIT"\)/);
  assert.match(accept, /client\.release\(\)/);
});


test("accepting contact requests shares the block pair lock", () => {
  const route = social.slice(social.indexOf('pathname === "/api/contacts/respond"'), social.indexOf('pathname === "/api/calls/config"'));
  assert.match(route, /if \(action === "accept"\)/);
  assert.match(route, /SELECT requester_id FROM contact_requests/);
  assert.match(route, /pg_advisory_xact_lock\(hashtextextended/);
  assert.match(route, /FROM user_blocks b/);
  assert.match(route, /await client\.query\("COMMIT"\)/);
  assert.match(route, /client\.release\(\)/);
});

test("message creation rechecks contact and block state under the shared pair lock", () => {
  const route = social.slice(social.indexOf('if (pathname === "/api/messages" && req.method === "POST")'));
  assert.match(route, /await client\.query\("BEGIN"\)/);
  assert.match(route, /pg_advisory_xact_lock\(hashtextextended/);
  assert.match(route, /const stillContact = await client\.query/);
  assert.match(route, /FROM user_blocks b/);
  assert.match(route, /INSERT INTO messages/);
  assert.match(route, /await client\.query\("COMMIT"\)/);
  assert.match(route, /client\.release\(\)/);
});


test("OTP issuance serializes per phone and delivers only the current challenge", () => {
  const requestRoute = auth.slice(auth.indexOf('pathname === "/api/auth/request-otp"'), auth.indexOf('pathname === "/api/auth/verify-otp"'));
  assert.match(requestRoute, /pg_advisory_xact_lock\(hashtextextended\(\$1::text, 3\)\)/);
  assert.match(requestRoute, /UPDATE otp_challenges SET consumed_at = NOW\(\) WHERE phone_e164 = \$1 AND consumed_at IS NULL/);
  assert.match(requestRoute, /await sendSms\(phone, code\)/);
  assert.match(requestRoute, /await client\.query\("COMMIT"\)/);
  assert.match(requestRoute, /client\.release\(\)/);
});


test("OTP verification shares the per-phone issuance lock before reading a challenge", () => {
  const verifyRoute = auth.slice(auth.indexOf('pathname === "/api/auth/verify-otp"'), auth.indexOf('pathname === "/api/auth/me"'));
  assert.match(verifyRoute, /BEGIN[\s\S]*pg_advisory_xact_lock\(hashtextextended\(\$1::text, 3\)\)[\s\S]*SELECT id, code_hash, attempts FROM otp_challenges[\s\S]*FOR UPDATE/);
});

test("chat and signaling sockets tolerate transient session verification failures", () => {
  assert.match(server, /let verificationFailures = 0/);
  assert.match(server, /verificationFailures = 0;[\s\S]*verificationFailures \+= 1;[\s\S]*verificationFailures >= 3/);
  assert.match(server, /let authVerificationFailures = 0/);
  assert.match(server, /authVerificationFailures = 0;[\s\S]*authVerificationFailures \+= 1;[\s\S]*authVerificationFailures >= 3/);
  assert.match(server, /if \(!current \|\| current\.id !== user\.id\) ws\.close\(1008, "Session expired"\)/);
});

test("signaling WebSocket periodically revalidates the login session and clears its timer", () => {
  const signaling = server.slice(server.indexOf('const wss = new WebSocket.Server'), server.indexOf('server.listen'));
  assert.match(signaling, /authTimer = setInterval\(async \(\) =>/);
  assert.match(signaling, /const current = await getUser\(req\)/);
  assert.match(signaling, /current\.id !== user\.id/);
  assert.match(signaling, /Session expired/);
  assert.match(signaling, /ws\.once\("close"|ws\.on\("close"/);
  assert.match(signaling, /clearInterval\(authTimer\)/);
});

test("live chat reconnects when mobile network returns or app tab becomes visible", () => {
  assert.match(frontend, /window\.addEventListener\("online",\s*connectChatSocket\)/);
  assert.match(frontend, /document\.addEventListener\("visibilitychange",\s*\(\)\s*=>\s*\{\s*if\(!document\.hidden&&currentUserId\)connectChatSocket\(\)/);
  assert.match(frontend, /WebSocket\.OPEN,WebSocket\.CONNECTING/);
});


test("active call participant lookups have narrow expiry indexes in schema and migration", () => {
  const schema = fs.readFileSync(path.join(root, "db/schema.sql"), "utf8");
  const migration = fs.readFileSync(path.join(root, "db/migrations/20261120_add_active_call_participant_indexes.sql"), "utf8");
  for (const source of [schema, migration]) {
    assert.ok(source.includes("call_invites_active_caller_expiry_idx"));
    assert.ok(source.includes("call_invites_active_callee_expiry_idx"));
    assert.ok(source.includes("(caller_id, expires_at)"));
    assert.ok(source.includes("(callee_id, expires_at)"));
    assert.ok(source.includes("WHERE status IN ('ringing', 'accepted')"));
  }
});


test("duplicate call-invitation conflicts report participant-wide busy state", () => {
  const route = social.slice(social.indexOf('pathname === "/api/calls/invite"'), social.indexOf('pathname === "/api/calls/respond"'));
  assert.match(route, /if \(error\.code === "23505"\)[\s\S]*You or this contact is already busy with another call/);
});
