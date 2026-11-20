const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizePhone, createOtp, hashOtp, verifyOtp,
  createSessionToken, hashSessionToken, isSameOriginRequest
} = require("../src/security");

const secret = "test-secret-that-is-long-enough-for-scrypt";

test("normalizes valid international phone numbers", () => {
  assert.equal(normalizePhone("+966 50-123-4567"), "+966501234567");
  assert.throws(() => normalizePhone("0501234567"));
});

test("creates six digit OTPs and verifies only matching code", async () => {
  const otp = createOtp();
  assert.match(otp, /^\d{6}$/);
  const hash = await hashOtp("+966501234567", otp, secret);
  assert.equal(await verifyOtp("+966501234567", otp, hash, secret), true);
  assert.equal(await verifyOtp("+966501234567", "000000", hash, secret), false);
  await assert.rejects(() => hashOtp("+966501234567", "12x456", secret));
  await assert.rejects(() => hashOtp("+966501234567", "12345", secret));
});

test("session tokens are random and stored as one-way hashes", () => {
  const token = createSessionToken();
  assert.ok(token.length >= 40);
  assert.notEqual(hashSessionToken(token), token);
  assert.notEqual(hashSessionToken(token), hashSessionToken(createSessionToken()));
});


test("same-origin validation accepts matching forwarded HTTPS origin", () => {
  const req = { headers: { origin: "https://lovemet.example", host: "lovemet.example", "x-forwarded-proto": "https, http" }, socket: {} };
  assert.equal(isSameOriginRequest(req), true);
});

test("same-origin validation rejects missing, foreign and protocol-mismatched origins", () => {
  const base = { headers: { host: "lovemet.example", "x-forwarded-proto": "https" }, socket: {} };
  assert.equal(isSameOriginRequest(base), false);
  assert.equal(isSameOriginRequest({ ...base, headers: { ...base.headers, origin: "https://evil.example" } }), false);
  assert.equal(isSameOriginRequest({ ...base, headers: { ...base.headers, origin: "http://lovemet.example" } }), false);
  assert.equal(isSameOriginRequest({ ...base, headers: { ...base.headers, origin: "not a url" } }), false);
});
