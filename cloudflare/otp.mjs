import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { allowRequest } from './rate-limit.mjs';
import { publishUserEvent } from './user-events.mjs';
const scrypt = promisify(scryptCallback);
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const MAX_BODY_BYTES = 8192; const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
function json(status, body, extra = {}) { return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } }); }
function sameOrigin(request) { try { const origin = request.headers.get('origin'); return Boolean(origin) && new URL(origin).origin === new URL(request.url).origin; } catch { return false; } }
function normalizePhone(value) { const phone = String(value || '').replace(/[\s()-]/g, ''); if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw Object.assign(new Error('Phone number must use international E.164 format.'), { status: 400 }); return phone; }
function hashSession(token) { return createHash('sha256').update(String(token)).digest('hex'); }
function readCookie(request, name) { for (const part of String(request.headers.get('cookie') || '').split(';')) { const i = part.indexOf('='); if (i < 0 || part.slice(0, i).trim() !== name) continue; try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } } return ''; }
async function readJson(request) { const reader = request.body?.getReader(); if (!reader) return {}; const chunks = []; let size = 0; try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BODY_BYTES) { await reader.cancel(); throw Object.assign(new Error('Request too large.'), { status: 413 }); } chunks.push(value); } } finally { reader.releaseLock(); } try { const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; } const body = JSON.parse(new TextDecoder().decode(raw) || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); } }
function assertSecret(secret) { if (typeof secret !== 'string' || secret.length < 32) throw Object.assign(new Error('OTP service is not configured.'), { status: 503 }); }
async function hashOtp(phone, code, secret) { assertSecret(secret); const salt = randomBytes(16); const derived = await scrypt(phone + ':' + code + ':' + secret, salt, 64); return salt.toString('hex') + ':' + derived.toString('hex'); }
async function verifyOtp(phone, code, stored, secret) { if (!/^\d{6}$/.test(code) || typeof stored !== 'string') return false; const parts = stored.split(':'); if (parts.length !== 2 || !/^[a-f0-9]{32}$/i.test(parts[0]) || !/^[a-f0-9]{128}$/i.test(parts[1])) return false; const actual = await scrypt(phone + ':' + code + ':' + secret, Buffer.from(parts[0], 'hex'), 64); return timingSafeEqual(actual, Buffer.from(parts[1], 'hex')); }
async function sendSms(phone, code, env, fetcher) {
 const sid = env?.TWILIO_ACCOUNT_SID; const auth = env?.TWILIO_AUTH_TOKEN; const from = env?.TWILIO_FROM_NUMBER;
 if (!sid || !auth || !from) throw new Error('SMS provider is not configured.');
 const endpoint = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json';
 const form = new URLSearchParams({ To: phone, From: from, Body: 'Your LoveMet verification code is ' + code + '. It expires in 5 minutes. Do not share it.' });
 const response = await fetcher(endpoint, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + auth).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(10000) });
 if (!response.ok) { const error = new Error('SMS delivery failed.'); error.providerStatus = response.status; throw error; }
}
function sessionCookie(token, request, maxAge = SESSION_TTL_SECONDS) { const secure = new URL(request.url).protocol === 'https:'; return 'lovemet_session=' + encodeURIComponent(token || '') + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure ? '; Secure' : ''); }
export async function handleOtpAndLogout(request, client, env, fetcher = fetch) {
 const pathname = new URL(request.url).pathname; const method = request.method;
 if (!['/api/auth/request-otp', '/api/auth/verify-otp', '/api/auth/logout'].includes(pathname)) return null;
 if (method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: { ...HEADERS, Allow: 'POST' } });
 if (!sameOrigin(request)) return json(403, { error: 'Cross-origin request blocked.' });
 try {
  if (pathname === '/api/auth/request-otp') {
   const body = await readJson(request); const phone = normalizePhone(body.phone); assertSecret(env?.OTP_HASH_SECRET);
   const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
   if (!(await allowRequest(client, env.OTP_HASH_SECRET, 'ip:' + ip, 10, 3600000)) || !(await allowRequest(client, env.OTP_HASH_SECRET, 'phone:' + phone, 3, 900000))) return json(429, { error: 'Too many requests. Try again later.' });
   const code = randomInt(0, 1000000).toString().padStart(6, '0'); const codeHash = await hashOtp(phone, code, env.OTP_HASH_SECRET);
   await client.query('BEGIN');
   try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 3))', [phone]);
    await client.query("DELETE FROM otp_challenges WHERE expires_at < NOW() - INTERVAL '1 day' OR consumed_at < NOW() - INTERVAL '1 day'");
    await client.query('UPDATE otp_challenges SET consumed_at = NOW() WHERE phone_e164 = $1 AND consumed_at IS NULL', [phone]);
    await client.query("INSERT INTO otp_challenges (phone_e164, code_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '5 minutes')", [phone, codeHash]);
    await sendSms(phone, code, env, fetcher); await client.query('COMMIT');
   } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
   return json(200, { ok: true, message: 'Verification code sent if the number can receive SMS.' });
  }
  if (pathname === '/api/auth/verify-otp') {
   const body = await readJson(request); const phone = normalizePhone(body.phone); assertSecret(env?.OTP_HASH_SECRET); const code = String(body.code || '');
   if (!/^\d{6}$/.test(code)) return json(400, { error: 'Enter the six-digit verification code.' });
   const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
   if (!(await allowRequest(client, env.OTP_HASH_SECRET, 'verify-ip:' + ip, 20, 900000)) || !(await allowRequest(client, env.OTP_HASH_SECRET, 'verify-phone:' + phone, 8, 900000))) return json(429, { error: 'Too many attempts. Request a new code later.' });
   await client.query('BEGIN');
   try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 3))', [phone]);
    const challengeResult = await client.query("SELECT id, code_hash, attempts FROM otp_challenges WHERE phone_e164 = $1 AND consumed_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [phone]);
    const challenge = challengeResult.rows[0];
    if (!challenge || challenge.attempts >= 5) { await client.query('ROLLBACK'); return json(400, { error: 'Code is invalid or expired. Request a new one.' }); }
    const valid = await verifyOtp(phone, code, challenge.code_hash, env.OTP_HASH_SECRET);
    await client.query('UPDATE otp_challenges SET attempts = attempts + 1, consumed_at = CASE WHEN $2 THEN NOW() ELSE consumed_at END WHERE id = $1', [challenge.id, valid]);
    if (!valid) { await client.query('COMMIT'); return json(400, { error: 'Code is invalid or expired.' }); }
    const userResult = await client.query("INSERT INTO users (phone_e164, phone_verified_at) VALUES ($1, NOW()) ON CONFLICT (phone_e164) DO UPDATE SET phone_verified_at = COALESCE(users.phone_verified_at, NOW()), updated_at = NOW() RETURNING id, display_name, username, avatar_url", [phone]);
    await client.query("DELETE FROM sessions WHERE expires_at <= NOW() OR revoked_at < NOW() - INTERVAL '30 days'");
    const user = userResult.rows[0]; const token = randomBytes(32).toString('base64url');
    await client.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')", [user.id, hashSession(token)]);
    await client.query('COMMIT'); return json(200, { ok: true, user }, { 'Set-Cookie': sessionCookie(token, request) });
   } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  }
  const token = readCookie(request, 'lovemet_session');
  if (token) {
   const result = await client.query("WITH revoked AS (UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id), ended AS (UPDATE call_invites SET status = 'ended', updated_at = NOW(), ended_at = NOW() WHERE status = 'accepted' AND (caller_id IN (SELECT user_id FROM revoked) OR callee_id IN (SELECT user_id FROM revoked)) RETURNING caller_id, callee_id) SELECT (SELECT user_id FROM revoked LIMIT 1) AS revoked_user_id, caller_id, callee_id FROM ended UNION ALL SELECT user_id, NULL::uuid, NULL::uuid FROM revoked WHERE NOT EXISTS (SELECT 1 FROM ended)", [hashSession(token)]);
   const participants = new Set(result.rows.flatMap(row => [row.revoked_user_id, row.caller_id, row.callee_id]).filter(Boolean));
   await Promise.all([...participants].map(userId => publishUserEvent(env, userId, { type: 'call-update' })));
   const revokedUserId = result.rows.find(row => row.revoked_user_id)?.revoked_user_id;
   if (revokedUserId) await publishUserEvent(env, revokedUserId, { type: 'session-ended' });
  }
  return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', request, 0) });
 } catch (error) { const status = error.status || 500; if (status >= 500) console.error('LoveMet Worker auth error:', error.message); return json(status, { error: status === 500 ? 'Authentication service error.' : error.message }); }
}