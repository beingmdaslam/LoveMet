import test from 'node:test';
import assert from 'node:assert/strict';
import { handleModeration } from '../cloudflare/moderation.mjs';
const token = 'moderation-session-token';
function db({ total = 2, target = true, report = [{ id: 'rep1', status: 'open', created_at: '2026-11-20T12:00:00Z' }] } = {}) {
 const calls = [];
 return { calls, async query(sql, args) { calls.push({ sql, args });
  if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [{ id: 'u1', display_name: 'Aslam', username: 'aslam', avatar_url: null }] };
  if (sql.includes('SELECT id FROM users')) return { rowCount: target ? 1 : 0, rows: target ? [{ id: 'u2' }] : [] };
  if (sql.includes('COUNT(*)::INTEGER')) return { rowCount: 1, rows: [{ total }] };
  if (sql.includes('INSERT INTO user_reports')) return { rowCount: 1, rows: report };
  if (sql.includes('DELETE FROM user_blocks')) return { rowCount: 1, rows: [{ blocked_id: 'u2' }] };
  return { rowCount: 0, rows: [] };
 } };
}
function eventSink() {
 const events = [];
 return { events, USER_EVENTS: { idFromName: userId => userId, get: userId => ({ fetch: async (_url, init) => { events.push({ userId, event: JSON.parse(init.body) }); return new Response(null, { status: 200 }); } }) } };
}
function req(path, body) { return new Request('https://lovemet.example' + path, { method: 'POST', headers: { origin: 'https://lovemet.example', cookie: 'lovemet_session=' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
test('blocking locks the pair, inserts the block and ends active calls', async () => {
 const client = db(); const sink = eventSink(); const response = await handleModeration(req('/api/contacts/block', { userId: '22222222-2222-4222-8222-222222222222' }), client, sink);
 assert.equal(response.status, 200); const sql = client.calls.map(call => call.sql); assert.ok(sql.includes('BEGIN')); assert.ok(sql.includes('COMMIT')); assert.ok(sql.some(value => value.includes('pg_advisory_xact_lock'))); assert.ok(sql.some(value => value.includes('INSERT INTO user_blocks'))); assert.ok(sql.some(value => value.includes('UPDATE call_invites'))); assert.deepEqual(sink.events.map(item => [item.userId, item.event.type]).sort(), [['22222222-2222-4222-8222-222222222222','call-update'],['22222222-2222-4222-8222-222222222222','contact-update'],['u1','call-update'],['u1','contact-update']].sort());
});
test('unblock only removes a block owned by the signed-in user', async () => {
 const client = db(); const sink = eventSink(); const response = await handleModeration(req('/api/contacts/unblock', { userId: '22222222-2222-4222-8222-222222222222' }), client, sink);
 assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, unblocked: true }); assert.deepEqual(client.calls.at(-1).args, ['u1', '22222222-2222-4222-8222-222222222222']); assert.equal(sink.events.length, 2); assert.ok(sink.events.every(item => item.event.type === 'contact-update'));
});
test('report submission serializes per reporter and enforces the daily cap', async () => {
 const client = db(); const response = await handleModeration(req('/api/users/report', { userId: '22222222-2222-4222-8222-222222222222', reason: 'spam', details: 'Repeated spam' }), client);
 assert.equal(response.status, 201); const sql = client.calls.map(call => call.sql); assert.ok(sql.some(value => value.includes('pg_advisory_xact_lock'))); assert.ok(sql.includes('BEGIN')); assert.ok(sql.includes('COMMIT'));
 const limited = db({ total: 5 }); const denied = await handleModeration(req('/api/users/report', { userId: '22222222-2222-4222-8222-222222222222', reason: 'spam', details: 'Repeated spam' }), limited); assert.equal(denied.status, 429); assert.ok(limited.calls.some(call => call.sql === 'ROLLBACK'));
});
test('moderation mutations reject cross-origin requests before database access', async () => {
 const client = db(); const response = await handleModeration(new Request('https://lovemet.example/api/contacts/block', { method: 'POST', headers: { origin: 'https://evil.example', cookie: 'lovemet_session=' + token }, body: '{}' }), client); assert.equal(response.status, 403); assert.equal(client.calls.length, 0);
});