import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../cloudflare/messages.mjs';
const token = 'chat-session-token';
const secret = '0123456789abcdef0123456789abcdef';
function fakeClient({ contact = true } = {}) {
 const calls = [];
 return { calls, async query(sql, args) {
  calls.push({ sql, args });
  if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [{ id: 'u1', display_name: 'Aslam', username: 'aslam', avatar_url: null }] };
  if (sql.includes('FROM contact_requests')) return { rowCount: contact ? 1 : 0, rows: contact ? [{ ok: 1 }] : [] };
  if (sql.includes('INSERT INTO api_rate_limits')) return { rowCount: 1, rows: [{ hit_count: 1 }] };
  if (sql.includes('INSERT INTO messages')) return { rowCount: 1, rows: [{ id: 'm1', sender_id: 'u1', recipient_id: 'u2', body: 'hello', created_at: '2026-11-20T12:00:00Z', delivered_at: null, read_at: null }] };
  if (sql.includes('SELECT id, sender_id, recipient_id, body')) return { rowCount: 1, rows: [{ id: 'm1', sender_id: 'u2', recipient_id: 'u1', body: 'hi', created_at: '2026-11-20T11:59:00Z', delivered_at: null, read_at: null }] };
  return { rowCount: 0, rows: [] };
 } };
}
test('message history is paginated and marks received messages read', async () => {
 const client = fakeClient();
 const request = new Request('https://lovemet.example/api/messages?contactId=22222222-2222-4222-8222-222222222222', { headers: { cookie: 'lovemet_session=' + token } });
 const response = await handleMessages(request, client, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 200);
 assert.equal((await response.json()).messages.length, 1);
 assert.ok(client.calls.some(call => call.sql.includes('SET delivered_at = COALESCE')));
 assert.ok(client.calls.some(call => call.sql.includes('LIMIT 51')));
});
test('message send uses a transaction, pair lock, rechecks contact and inserts safely', async () => {
 const client = fakeClient();
 const request = new Request('https://lovemet.example/api/messages', { method: 'POST', headers: { origin: 'https://lovemet.example', cookie: 'lovemet_session=' + token, 'content-type': 'application/json' }, body: JSON.stringify({ contactId: '22222222-2222-4222-8222-222222222222', message: ' hello ' }) });
 const response = await handleMessages(request, client, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 201);
 assert.equal((await response.json()).message.body, 'hello');
 const sql = client.calls.map(call => call.sql);
 assert.ok(sql.includes('BEGIN')); assert.ok(sql.includes('COMMIT'));
 assert.ok(sql.some(value => value.includes('pg_advisory_xact_lock')));
 assert.ok(sql.some(value => value.includes('INSERT INTO api_rate_limits')));
});
test('message send rejects non-canonical contact UUIDs', async () => {
 const client = fakeClient();
 const request = new Request('https://lovemet.example/api/messages', { method: 'POST', headers: { origin: 'https://lovemet.example', cookie: 'lovemet_session=' + token, 'content-type': 'application/json' }, body: JSON.stringify({ contactId: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', message: 'hello' }) });
 const response = await handleMessages(request, client, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 400);
 assert.equal(client.calls.some(call => call.sql.includes('FROM contact_requests')), false);
});
test('message send rejects cross-origin requests before database access', async () => {
 const client = fakeClient();
 const response = await handleMessages(new Request('https://lovemet.example/api/messages', { method: 'POST', headers: { origin: 'https://evil.example', cookie: 'lovemet_session=' + token }, body: '{}' }), client, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 403); assert.equal(client.calls.length, 0);
});
test('message history refuses blocked or non-contact users', async () => {
 const client = fakeClient({ contact: false });
 const response = await handleMessages(new Request('https://lovemet.example/api/messages?contactId=22222222-2222-4222-8222-222222222222', { headers: { cookie: 'lovemet_session=' + token } }), client, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 403);
});
test('invalid message cursor is rejected before changing read receipts', async () => {
 const client = fakeClient();
 const request = new Request('https://lovemet.example/api/messages?contactId=22222222-2222-4222-8222-222222222222&before=not-a-date&beforeId=33333333-3333-4333-8333-333333333333', { headers: { cookie: 'lovemet_session=' + token } });
 const response = await handleMessages(request, client, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 400);
 assert.equal(client.calls.some(call => call.sql.includes('SET delivered_at = COALESCE')), false);
});
