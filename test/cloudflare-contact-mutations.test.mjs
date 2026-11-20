import test from 'node:test';
import assert from 'node:assert/strict';
import { handleContactMutation } from '../cloudflare/contact-mutations.mjs';
const token = 'contact-session-token'; const secret = '0123456789abcdef0123456789abcdef';
function fake({ existing = [], pending = [{ requester_id: 'u2' }], updated = [{ id: 'req1', status: 'accepted' }] } = {}) {
 const calls = [];
 return { calls, async query(sql, args) {
  calls.push({ sql, args });
  if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [{ id: 'u1', display_name: 'Aslam', username: 'aslam', avatar_url: null }] };
  if (sql.includes('INSERT INTO api_rate_limits')) return { rowCount: 1, rows: [{ hit_count: 1 }] };
  if (sql.includes('SELECT id FROM users')) return { rowCount: 1, rows: [{ id: 'u2' }] };
  if (sql.includes('FROM user_blocks')) return { rowCount: 0, rows: [] };
  if (sql.includes('SELECT id, status FROM contact_requests')) return { rowCount: existing.length, rows: existing };
  if (sql.includes('INSERT INTO contact_requests')) return { rowCount: 1, rows: [{ id: 'req1', status: 'pending', created_at: '2026-11-20T12:00:00Z' }] };
  if (sql.includes('SELECT requester_id FROM contact_requests')) return { rowCount: pending.length, rows: pending };
  if (sql.includes('UPDATE contact_requests')) return { rowCount: updated.length, rows: updated };
  return { rowCount: 0, rows: [] };
 } };
}
function request(path, body) { return new Request('https://lovemet.example' + path, { method: 'POST', headers: { origin: 'https://lovemet.example', cookie: 'lovemet_session=' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
test('contact request uses rate limit, unordered pair lock and rechecks blocks before insert', async () => {
 const db = fake(); const response = await handleContactMutation(request('/api/contacts/request', { username: '@friend' }), db, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 201); assert.equal((await response.json()).request.status, 'pending');
 const sql = db.calls.map(call => call.sql); assert.ok(sql.includes('BEGIN')); assert.ok(sql.includes('COMMIT')); assert.ok(sql.some(value => value.includes('pg_advisory_xact_lock'))); assert.ok(sql.some(value => value.includes('INSERT INTO api_rate_limits'))); assert.ok(sql.some(value => value.includes('INSERT INTO contact_requests')));
});
test('accepting a contact request locks the pair and refuses a blocked relationship', async () => {
 const db = fake({ updated: [] }); const response = await handleContactMutation(request('/api/contacts/respond', { requestId: '11111111-1111-4111-8111-111111111111', action: 'accept' }), db, {});
 assert.equal(response.status, 404); const sql = db.calls.map(call => call.sql); assert.ok(sql.includes('BEGIN')); assert.ok(sql.some(value => value.includes('pg_advisory_xact_lock'))); assert.ok(sql.some(value => value.includes('NOT EXISTS'))); assert.ok(sql.includes('ROLLBACK'));
});
test('declining a request updates only a pending request addressed to the current user', async () => {
 const db = fake({ updated: [{ id: 'req1', status: 'declined' }] }); const response = await handleContactMutation(request('/api/contacts/respond', { requestId: '11111111-1111-4111-8111-111111111111', action: 'decline' }), db, {});
 assert.equal(response.status, 200); assert.equal((await response.json()).request.status, 'declined'); assert.ok(db.calls.at(-1).sql.includes("status = 'pending'"));
});
test('contact mutation rejects cross-origin before querying', async () => {
 const db = fake(); const req = new Request('https://lovemet.example/api/contacts/request', { method: 'POST', headers: { origin: 'https://evil.example', cookie: 'lovemet_session=' + token }, body: '{}' });
 const response = await handleContactMutation(req, db, { OTP_HASH_SECRET: secret }); assert.equal(response.status, 403); assert.equal(db.calls.length, 0);
});