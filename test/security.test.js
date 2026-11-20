const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizePhone, createOtp, hashOtp, verifyOtp,
  createSessionToken, hashSessionToken
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
});

test("session tokens are random and stored as one-way hashes", () => {
  const token = createSessionToken();
  assert.ok(token.length >= 40);
  assert.notEqual(hashSessionToken(token), token);
  assert.notEqual(hashSessionToken(token), hashSessionToken(createSessionToken()));
});
