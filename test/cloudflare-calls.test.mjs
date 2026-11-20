import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { handleCallsRead } from '../cloudflare/calls.mjs';
const token = 'call-session-token';
function db(rows = []) { const calls = []; return { calls, async query(sql, args) { calls.push({ sql, args }); if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [{ id: 'u1', display_name: 'Aslam', username: 'aslam', avatar_url: null }] }; return { rowCount: rows.length, rows }; } }; }
test('call config returns STUN and a time-limited TURN credential when configured', async () => {
 const client = db(); const secret = '0123456789abcdef0123456789abcdef';
 const response = await handleCallsRead(new Request('https://lovemet.example/api/calls/config', { headers: { cookie: 'lovemet_session=' + token } }), client, { TURN_URLS: 'turn:turn.example:3478,invalid-url', TURN_SHARED_SECRET: secret });
 assert.equal(response.status, 200); const payload = await response.json(); assert.equal(payload.iceServers.length, 2);
 const turn = payload.iceServers[1]; assert.equal(turn.urls[0], 'turn:turn.example:3478');
 assert.equal(turn.credential, createHmac('sha1', secret).update(turn.username).digest('base64'));
 assert.ok(Number(turn.username.split(':')[0]) > Math.floor(Date.now() / 1000));
});
test('call history returns only calls involving the authenticated account', async () => {
 const client = db([{ id: 'c1', status: 'ended', contact_id: 'u2', outgoing: true, duration_seconds: 45 }]);
 const response = await handleCallsRead(new Request('https://lovemet.example/api/calls/history', { headers: { cookie: 'lovemet_session=' + token } }), client, {});
 assert.equal(response.status, 200); assert.deepEqual(await response.json(), { calls: [{ id: 'c1', status: 'ended', contact_id: 'u2', outgoing: true, duration_seconds: 45 }] });
 assert.deepEqual(client.calls[1].args, ['u1']); assert.ok(client.calls[1].sql.includes('LIMIT 30'));
});
test('call endpoints reject unauthenticated requests', async () => {
 const response = await handleCallsRead(new Request('https://lovemet.example/api/calls/history'), { async query() { return { rowCount: 0, rows: [] }; } }, {});
 assert.equal(response.status, 401);
});
test('incoming invite polling expires ringing and accepted calls only for the signed-in participant', async () => {
 const client = db();
 const response = await handleCallsRead(new Request('https://lovemet.example/api/calls/invites', { headers: { cookie: 'lovemet_session=' + token } }), client, {});
 assert.equal(response.status, 200); assert.deepEqual(await response.json(), { invites: [] });
 const updates = client.calls.filter(call => call.sql.startsWith('UPDATE call_invites'));
 assert.equal(updates.length, 2);
 assert.ok(updates[0].sql.includes("status = 'missed'")); assert.ok(updates[0].sql.includes('expires_at <= NOW()'));
 assert.ok(updates[1].sql.includes("status = 'ended'")); assert.ok(updates[1].sql.includes("status = 'accepted'"));
 assert.deepEqual(updates[0].args, ['u1']); assert.deepEqual(updates[1].args, ['u1']);
});

test('call status lookup is scoped to the current participant and rejects unknown invitations', async () => {
 const client = db();
 const response = await handleCallsRead(new Request('https://lovemet.example/api/calls/status?inviteId=11111111-1111-4111-8111-111111111111', { headers: { cookie: 'lovemet_session=' + token } }), client, {});
 assert.equal(response.status, 404);
 assert.deepEqual(client.calls.at(-1).args, ['11111111-1111-4111-8111-111111111111', 'u1']);
 assert.ok(client.calls.at(-1).sql.includes('(caller_id = $2 OR callee_id = $2)'));
});