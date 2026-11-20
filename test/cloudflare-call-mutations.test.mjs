import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCallMutation } from '../cloudflare/call-mutations.mjs';
const token = 'call-mutation-session'; const secret = '0123456789abcdef0123456789abcdef';
function db({ busy = false, invite = true, accepted = true } = {}) { const calls = []; return { calls, async query(sql, args) { calls.push({ sql, args });
 if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [{ id: 'u1', display_name: 'Aslam', username: 'aslam', avatar_url: null }] };
 if (sql.includes('INSERT INTO api_rate_limits')) return { rowCount: 1, rows: [{ hit_count: 1 }] };
 if (sql.includes('FROM contact_requests')) return { rowCount: accepted ? 1 : 0, rows: accepted ? [{ ok: 1 }] : [] };
 if (sql.includes('COUNT(*)::INTEGER')) return { rowCount: 1, rows: [{ total: 0 }] };
 if (sql.includes('SELECT id FROM call_invites')) return { rowCount: busy ? 1 : 0, rows: busy ? [{ id: 'busy' }] : [] };
 if (sql.includes('SELECT caller_id, callee_id FROM call_invites')) return { rowCount: invite ? 1 : 0, rows: invite ? [{ caller_id: 'u2', callee_id: 'u1' }] : [] };
 if (sql.includes('INSERT INTO call_invites')) return { rowCount: 1, rows: [{ id: 'new-invite', caller_id: 'u1', callee_id: 'u2', status: 'ringing' }] };
 if (sql.includes('UPDATE call_invites') && sql.includes('RETURNING')) return { rowCount: invite && accepted ? 1 : 0, rows: invite && accepted ? [{ id: 'invite1', caller_id: 'u2', callee_id: 'u1', status: 'accepted', expires_at: '2026-11-20T16:00:00Z' }] : [] };
 return { rowCount: 0, rows: [] }; } }; }
function eventSink() { const events = []; return { events, USER_EVENTS: { idFromName: userId => userId, get: userId => ({ fetch: async (_url, init) => { events.push({ userId, event: JSON.parse(init.body) }); return new Response(null, { status: 200 }); } }) } }; }
function req(path, body) { return new Request('https://lovemet.example' + path, { method: 'POST', headers: { origin: 'https://lovemet.example', cookie: 'lovemet_session=' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
test('call invitation requires an accepted contact and serializes both participants', async () => {
 const client = db(); const events = eventSink(); const response = await handleCallMutation(req('/api/calls/invite', { contactId: '22222222-2222-4222-8222-222222222222' }), client, { OTP_HASH_SECRET: secret, USER_EVENTS: events.USER_EVENTS });
 assert.equal(response.status, 201); const sql = client.calls.map(call => call.sql); assert.ok(sql.includes('BEGIN')); assert.ok(sql.includes('COMMIT')); assert.ok(sql.some(value => value.includes('hashtextextended($1::text, 4)'))); assert.ok(sql.some(value => value.includes('INSERT INTO call_invites'))); assert.deepEqual(events.events, [{ userId: '22222222-2222-4222-8222-222222222222', event: { type: 'call-update' } }]);
});
test('call invitation refuses a busy participant', async () => {
 const client = db({ busy: true }); const response = await handleCallMutation(req('/api/calls/invite', { contactId: '22222222-2222-4222-8222-222222222222' }), client, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 409); assert.ok(client.calls.some(call => call.sql === 'ROLLBACK'));
});
test('accepting a call locks both participants and rejects a newly blocked pair', async () => {
 const client = db({ accepted: false }); const response = await handleCallMutation(req('/api/calls/respond', { inviteId: '11111111-1111-4111-8111-111111111111', action: 'accept' }), client, {});
 assert.equal(response.status, 403); assert.ok(client.calls.some(call => call.sql.includes('pg_advisory_xact_lock'))); assert.ok(client.calls.some(call => call.sql === 'ROLLBACK'));
});
test('decline updates only the ringing invite addressed to the current user', async () => {
 const client = db(); const events = eventSink(); const response = await handleCallMutation(req('/api/calls/respond', { inviteId: '11111111-1111-4111-8111-111111111111', action: 'decline' }), client, { USER_EVENTS: events.USER_EVENTS });
 assert.equal(response.status, 200); assert.ok(client.calls.at(-1).sql.includes("status = 'ringing'")); assert.deepEqual(client.calls.at(-1).args, ['11111111-1111-4111-8111-111111111111', 'u1']); assert.deepEqual(events.events, [{ userId: 'u2', event: { type: 'call-update' } }, { userId: 'u1', event: { type: 'call-update' } }]);
});