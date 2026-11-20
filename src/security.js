const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const OTP_TTL_MS = 5 * 60 * 1000;

function normalizePhone(phone) {
  const value = String(phone || "").replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error("Phone number must use international E.164 format.");
  }
  return value;
}

function createOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function assertOtpSecret(secret) {
  if (!secret || String(secret).length < 32) {
    throw new Error("OTP_HASH_SECRET must contain at least 32 characters.");
  }
}

async function hashOtp(phone, otp, secret) {
  assertOtpSecret(secret);
  if (!/^\d{6}$/.test(String(otp || ""))) throw new Error("OTP must contain exactly six digits.");
  const salt = crypto.randomBytes(16);
  const value = await scrypt(`${normalizePhone(phone)}:${otp}:${secret}`, salt, 64);
  return `${salt.toString("hex")}:${value.toString("hex")}`;
}

async function verifyOtp(phone, otp, storedHash, secret) {
  if (!/^\d{6}$/.test(String(otp || "")) || typeof storedHash !== "string") return false;
  const [saltHex, hashHex, extra] = storedHash.split(":");
  if (extra || !/^[a-f0-9]{32}$/i.test(saltHex || "") || !/^[a-f0-9]{128}$/i.test(hashHex || "")) return false;
  const actual = await scrypt(`${normalizePhone(phone)}:${otp}:${secret}`, Buffer.from(saltHex, "hex"), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hashHex, "hex"));
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

module.exports = {
  OTP_TTL_MS,
  normalizePhone,
  createOtp,
  hashOtp,
  verifyOtp,
  createSessionToken,
  hashSessionToken
};
