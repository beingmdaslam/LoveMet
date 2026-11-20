import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { handleOtpAndLogout } from '../cloudflare/otp.mjs';
const scrypt = promisify(scryptCallback); const secret = '0123456789abcdef0123456789abcdef'; const phone = '+14155550123';
async function otpHash(code) { const salt = randomBytes(16); const value = await scrypt(phone + ':' + code + ':' + secret, salt, 64); return salt.toString('hex') + ':' + value.toString('hex'); }
function req(path, body, headers = {}) { return new Request('https://lovemet.example' + path, { method: 'POST', headers: { origin: 'https://lovemet.example', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); }
function baseDb() { const calls = []; return { calls, async query(sql, args) { calls.push({ sql, args }); if (sql.includes('INSERT INTO api_rate_limits')) return { rowCount: 1, rows: [{ hit_count: 1 }] }; return { rowCount: 0, rows: [] }; } }; }
test('OTP verification consumes a valid challenge and creates an opaque session cookie', async () => {
 const code = '123456'; const challengeHash = await otpHash(code); const db = baseDb();
 db.query = async (sql, args) => { db.calls.push({ sql, args }); if (sql.includes('INSERT INTO api_rate_limits')) return { rowCount: 1, rows: [{ hit_count: 1 }] }; if (sql.includes('FROM otp_challenges')) return { rowCount: 1, rows: [{ id: 'otp1', code_hash: challengeHash, attempts: 0 }] }; if (sql.includes('INSERT INTO users')) return { rowCount: 1, rows: [{ id: 'u1', display_name: 'Aslam', username: null, avatar_url: null }] }; return { rowCount: 1, rows: [] }; };
 const response = await handleOtpAndLogout(req('/api/auth/verify-otp', { phone, code }), db, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 200); assert.deepEqual((await response.json()).user, { id: 'u1', display_name: 'Aslam', username: null, avatar_url: null });
 const cookie = response.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
 assert.ok(db.calls.some(call => call.sql.includes('consumed_at = CASE WHEN'))); assert.ok(db.calls.some(call => call.sql.includes('INSERT INTO sessions'))); assert.ok(db.calls.some(call => call.sql === 'COMMIT'));
});
test('OTP request rolls back challenge issuance when SMS delivery is not configured', async () => {
 const db = baseDb(); const response = await handleOtpAndLogout(req('/api/auth/request-otp', { phone }), db, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 500); assert.ok(db.calls.some(call => call.sql.includes('INSERT INTO otp_challenges'))); assert.ok(db.calls.some(call => call.sql === 'ROLLBACK'));
});
test('logout revokes the session and ends active calls while clearing the cookie', async () => {
 const db = baseDb(); const response = await handleOtpAndLogout(req('/api/auth/logout', undefined, { cookie: 'lovemet_session=opaque-token' }), db, {});
 assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Max-Age=0/); assert.ok(db.calls[0].sql.includes('WITH revoked AS')); assert.ok(db.calls[0].sql.includes("status = 'ended'"));
});
test('OTP and logout mutations reject foreign origins before database access', async () => {
 const db = baseDb(); const response = await handleOtpAndLogout(req('/api/auth/logout', {}, { origin: 'https://attacker.example' }), db, {});
 assert.equal(response.status, 403); assert.equal(db.calls.length, 0);
});
test('OTP endpoints reject invalid phone numbers before database access', async () => {
 const db = baseDb();
 const response = await handleOtpAndLogout(req('/api/auth/request-otp', { phone: '12345' }), db, { OTP_HASH_SECRET: secret });
 assert.equal(response.status, 400);
 assert.equal(db.calls.length, 0);
});
test('OTP endpoints report missing or weak hash secret as service unavailable', async () => {
 const db = baseDb();
 const response = await handleOtpAndLogout(req('/api/auth/request-otp', { phone }), db, { OTP_HASH_SECRET: 'too-short' });
 assert.equal(response.status, 503);
 assert.equal(db.calls.length, 0);
});
test('OTP challenge is rolled back when the SMS provider rejects delivery', async () => {
 const db = baseDb();
 const response = await handleOtpAndLogout(req('/api/auth/request-otp', { phone }), db, { OTP_HASH_SECRET: secret, TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'test-token', TWILIO_FROM_NUMBER: '+14155550000' }, async () => new Response('rejected', { status: 400 }));
 assert.equal(response.status, 500);
 assert.ok(db.calls.some(call => call.sql.includes('INSERT INTO otp_challenges')));
 assert.ok(db.calls.some(call => call.sql === 'ROLLBACK'));
});
