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