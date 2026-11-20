import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCallsRead } from '../cloudflare/calls.mjs';
function client() { const calls = []; return { calls, async query(sql, args) { calls.push({ sql, args }); if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [{ id: 'u1', display_name: 'Aslam', username: 'aslam', avatar_url: null }] }; if (sql.includes('SELECT id, status, expires_at')) return { rowCount: 1, rows: [{ id: 'invite-1', status: 'accepted', expires_at: '2026-11-20T13:00:00Z' }] }; if (sql.includes('SELECT c.id, c.caller_id')) return { rowCount: 1, rows: [{ id: 'invite-1', caller_id: 'u2', callee_id: 'u1', status: 'ringing' }] }; return { rowCount: 0, rows: [] }; } }; }
test('incoming call polling expires stale calls and returns only current-user invitations', async () => {
 const db = client(); const response = await handleCallsRead(new Request('https://lovemet.example/api/calls/invites', { headers: { cookie: 'lovemet_session=call-session' } }), db, {});
 assert.equal(response.status, 200); assert.equal((await response.json()).invites.length, 1);
 assert.ok(db.calls.some(call => call.sql.includes("status = 'missed'"))); assert.ok(db.calls.some(call => call.sql.includes("status = 'ended'"))); assert.deepEqual(db.calls.at(-1).args, ['u1']);
});
test('call status is scoped to an invitation participant and requires a UUID', async () => {
 const db = client(); const response = await handleCallsRead(new Request('https://lovemet.example/api/calls/status?inviteId=11111111-1111-4111-8111-111111111111', { headers: { cookie: 'lovemet_session=call-session' } }), db, {});
 assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'accepted', expiresAt: '2026-11-20T13:00:00Z' }); assert.deepEqual(db.calls[1].args, ['11111111-1111-4111-8111-111111111111', 'u1']);
 const invalid = await handleCallsRead(new Request('https://lovemet.example/api/calls/status?inviteId=nope', { headers: { cookie: 'lovemet_session=call-session' } }), client(), {}); assert.equal(invalid.status, 400);
});