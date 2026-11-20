import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleAccountDelete } from '../cloudflare/account.mjs';
const token = 'account-delete-session';
function db() { const calls = []; return { calls, async query(sql, args) { calls.push({ sql, args }); if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [{ id: 'u1', phone_e164: '+14155550123' }] }; if (sql.includes('SELECT caller_id, callee_id FROM call_invites')) return { rowCount: 1, rows: [{ caller_id: 'u1', callee_id: 'u2' }] }; return { rowCount: 1, rows: [] }; } }; }
function eventSink() { const events = []; return { events, USER_EVENTS: { idFromName: userId => userId, get: userId => ({ fetch: async (_url, init) => { events.push({ userId, event: JSON.parse(init.body) }); return new Response(null, { status: 200 }); } }) } }; }
test('account deletion removes OTP challenges and user in a transaction and clears session cookie', async () => {
 const client = db(); const events = eventSink(); const response = await handleAccountDelete(new Request('https://lovemet.example/api/account', { method: 'DELETE', headers: { origin: 'https://lovemet.example', cookie: 'lovemet_session=' + token } }), client, { USER_EVENTS: events.USER_EVENTS });
 assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true }); assert.match(response.headers.get('set-cookie'), /Max-Age=0/); assert.match(response.headers.get('set-cookie'), /HttpOnly/);
 assert.deepEqual(client.calls[0].args, [createHash('sha256').update(token).digest('hex')]); assert.ok(client.calls.some(call => call.sql.includes('DELETE FROM otp_challenges'))); assert.ok(client.calls.some(call => call.sql.includes('DELETE FROM users'))); assert.ok(client.calls.some(call => call.sql === 'COMMIT'));
 assert.deepEqual(events.events, [{ userId: 'u1', event: { type: 'call-update' } }, { userId: 'u2', event: { type: 'call-update' } }, { userId: 'u1', event: { type: 'session-ended' } }]);
});
test('account deletion rejects foreign origins without looking up the account', async () => {
 const client = db(); const response = await handleAccountDelete(new Request('https://lovemet.example/api/account', { method: 'DELETE', headers: { origin: 'https://attacker.example', cookie: 'lovemet_session=' + token } }), client, {});
 assert.equal(response.status, 403); assert.equal(client.calls.length, 0);
});