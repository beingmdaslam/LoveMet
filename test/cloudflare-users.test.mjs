import test from 'node:test';
import assert from 'node:assert/strict';
import { handleUserLookup } from '../cloudflare/users.mjs';
const secret = '0123456789abcdef0123456789abcdef';
function client() {
 const calls = [];
 return { calls, async query(sql, args) { calls.push({ sql, args }); if (sql.includes('FROM sessions')) return { rowCount: 1, rows: [{ id: 'u1', display_name: 'Aslam', username: 'aslam', avatar_url: null }] }; if (sql.includes('INSERT INTO api_rate_limits')) return { rowCount: 1, rows: [{ hit_count: 1 }] }; return { rowCount: 1, rows: [{ id: 'u2', username: 'friend', display_name: 'Friend', avatar_url: null }] }; } };
}
test('username search rate-limits, validates term and excludes blocked users', async () => {
 const db = client();
 const response = await handleUserLookup(new Request('https://lovemet.example/api/users/search?username=%40fri'), db, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), { users: [{ id: 'u2', username: 'friend', display_name: 'Friend', avatar_url: null }] });
 assert.ok(db.calls.some(call => call.sql.includes('INSERT INTO api_rate_limits')));
 assert.ok(db.calls.some(call => call.sql.includes('NOT EXISTS')));
 assert.deepEqual(db.calls.at(-1).args, ['fri%', 'u1']);
});
test('username search rejects invalid terms', async () => {
 const db = client();
 const response = await handleUserLookup(new Request('https://lovemet.example/api/users/search?username=ab'), db, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 400);
 assert.equal(db.calls.length, 2);
});
test('blocked-user list is scoped to the signed-in account', async () => {
 const db = client();
 const response = await handleUserLookup(new Request('https://lovemet.example/api/contacts/blocks'), db, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 200);
 assert.deepEqual(db.calls[1].args, ['u1']);
 assert.ok(db.calls[1].sql.includes('b.blocker_id = $1'));
});