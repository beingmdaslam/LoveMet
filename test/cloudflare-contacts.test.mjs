import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleContactsGet } from '../cloudflare/contacts.mjs';
const token = 'contacts-session-token';
const tokenHash = createHash('sha256').update(token).digest('hex');
function mockClient(rows) {
 const calls = [];
 return { calls, async query(sql, args) { calls.push({ sql, args }); if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [{ id: 'u1', display_name: 'Aslam', username: 'aslam', avatar_url: null }] }; return { rowCount: rows.length, rows }; } };
}
test('contacts endpoint returns accepted unblocked public contacts', async () => {
 const client = mockClient([{ id: 'u2', username: 'friend', display_name: 'Friend', avatar_url: null }]);
 const response = await handleContactsGet(new Request('https://lovemet.example/api/contacts', { headers: { cookie: 'lovemet_session=' + token } }), client);
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), { contacts: [{ id: 'u2', username: 'friend', display_name: 'Friend', avatar_url: null }] });
 assert.deepEqual(client.calls[0].args, [tokenHash]);
 assert.ok(client.calls[1].sql.includes("c.status = 'accepted'"));
 assert.ok(client.calls[1].sql.includes('NOT EXISTS'));
});
test('incoming requests endpoint limits results and excludes blocked accounts', async () => {
 const client = mockClient([{ id: 'r1', user_id: 'u2', username: 'friend', display_name: 'Friend', avatar_url: null }]);
 const response = await handleContactsGet(new Request('https://lovemet.example/api/contacts/requests', { headers: { cookie: 'lovemet_session=' + token } }), client);
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), { requests: [{ id: 'r1', user_id: 'u2', username: 'friend', display_name: 'Friend', avatar_url: null }] });
 assert.ok(client.calls[1].sql.includes("c.status = 'pending'"));
 assert.ok(client.calls[1].sql.includes('LIMIT 50'));
 assert.ok(client.calls[1].sql.includes('NOT EXISTS'));
});
test('contacts endpoint rejects unauthenticated requests', async () => {
 const response = await handleContactsGet(new Request('https://lovemet.example/api/contacts'), { async query() { return { rowCount: 0, rows: [] }; } });
 assert.equal(response.status, 401);
});