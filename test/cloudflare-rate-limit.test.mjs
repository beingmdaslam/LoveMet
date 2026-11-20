import test from 'node:test';
import assert from 'node:assert/strict';
import { allowRequest } from '../cloudflare/rate-limit.mjs';
const secret = '0123456789abcdef0123456789abcdef';
test('rate limiter binds the window parameter and enforces the returned hit count', async () => {
 const calls = []; let hitCount = 1;
 const client = { async query(sql, args) { calls.push({ sql, args }); return { rows: [{ hit_count: hitCount }] }; } };
 assert.equal(await allowRequest(client, secret, 'phone:+14155550123', 3, 900000), true);
 assert.match(calls[0].sql, /NOW\(\) \+ \(\$2::double precision \* INTERVAL '1 millisecond'\)/);
 assert.deepEqual(calls[0].args.slice(1), [900000]);
 hitCount = 4;
 assert.equal(await allowRequest(client, secret, 'phone:+14155550123', 3, 900000), false);
});
test('rate limiter rejects a missing or weak HMAC secret before database access', async () => {
 let called = false; const client = { async query() { called = true; return { rows: [{ hit_count: 1 }] }; } };
 await assert.rejects(() => allowRequest(client, 'short', 'ip:127.0.0.1', 10, 60000), /secret is not configured/);
 assert.equal(called, false);
});