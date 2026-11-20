const crypto = require("node:crypto");
const { Pool } = require("pg");
const {
  normalizePhone, createOtp, hashOtp, verifyOtp,
  createSessionToken, hashSessionToken
} = require("./security");

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  max: 5,
  connectionTimeoutMillis: 5000
}) : null;

if (pool) {
  pool.on("error", (error) => {
    console.error("LoveMet PostgreSQL idle-client error:", error.message);
  });
}

const requestLimits = new Map();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024;

function parsePhone(value) {
  try { return normalizePhone(value); }
  catch (error) { error.status = 400; throw error; }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  res.end(JSON.stringify(body));
}

function getClientIp(req) {
  // Trust the direct socket address; do not trust arbitrary X-Forwarded-For headers.
  return req.socket.remoteAddress || "unknown";
}

function allowRequest(key, max, windowMs) {
  const now = Date.now();
  if (requestLimits.size > 10000) {
    for (const [storedKey, entry] of requestLimits) {
      if (now >= entry.resetAt) requestLimits.delete(storedKey);
    }
  }
  const entry = requestLimits.get(key);
  if (!entry || now >= entry.resetAt) {
    requestLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large."), { status: 413 });
  }
  try {
    const value = JSON.parse(body || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
}

async function sendSms(phone, code) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    throw new Error("SMS provider is not configured.");
  }
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`;
  const form = new URLSearchParams({
    To: phone,
    From: TWILIO_FROM_NUMBER,
    Body: `Your LoveMet verification code is ${code}. It expires in 5 minutes. Do not share it.`
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form,
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    const error = new Error("SMS delivery failed.");
    error.providerStatus = response.status;
    throw error;
  }
}

function cookieOptions(req, maxAge) {
  const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
  return `lovemet_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const part of cookies) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ""; }
    }
  }
  return "";
}

async function currentUser(req) {
  if (!pool) return null;
  const token = readCookie(req, "lovemet_session");
  if (!token || token.length > 200) return null;
  const result = await pool.query(
    `SELECT u.id, u.phone_e164, u.display_name, u.username, u.avatar_url
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
     LIMIT 1`,
    [hashSessionToken(token)]
  );
  return result.rows[0] || null;
}

async function handleAuthRequest(req, res, pathname) {
  if (!pathname.startsWith("/api/auth/") && pathname !== "/api/profile") return false;
  if (!["POST", "GET", "PATCH"].includes(req.method)) {
    json(res, 405, { error: "Method not allowed." }, { Allow: "GET, POST, PATCH" });
    return true;
  }
  if (!pool) {
    json(res, 503, { error: "Account service is not configured yet." });
    return true;
  }

  try {
    if (pathname === "/api/auth/request-otp" && req.method === "POST") {
      const body = await readJson(req);
      const phone = parsePhone(body.phone);
      const ip = getClientIp(req);
      if (!allowRequest(`ip:${ip}`, 10, 60 * 60 * 1000) ||
          !allowRequest(`phone:${phone}`, 3, 15 * 60 * 1000)) {
        json(res, 429, { error: "Too many requests. Try again later." });
        return true;
      }
      if (!process.env.OTP_HASH_SECRET || process.env.OTP_HASH_SECRET.length < 32) {
        json(res, 503, { error: "OTP service is not configured." });
        return true;
      }

      const code = createOtp();
      const codeHash = await hashOtp(phone, code, process.env.OTP_HASH_SECRET);
      await pool.query(
        `INSERT INTO otp_challenges (phone_e164, code_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
        [phone, codeHash]
      );
      try {
        await sendSms(phone, code);
      } catch (error) {
        await pool.query(
          "UPDATE otp_challenges SET consumed_at = NOW() WHERE phone_e164 = $1 AND consumed_at IS NULL",
          [phone]
        );
        throw error;
      }
      json(res, 200, { ok: true, message: "Verification code sent if the number can receive SMS." });
      return true;
    }

    if (pathname === "/api/auth/verify-otp" && req.method === "POST") {
      const body = await readJson(req);
      const phone = parsePhone(body.phone);
      if (!process.env.OTP_HASH_SECRET || process.env.OTP_HASH_SECRET.length < 32) {
        json(res, 503, { error: "OTP service is not configured." });
        return true;
      }
      const code = String(body.code || "");
      if (!/^\d{6}$/.test(code)) {
        json(res, 400, { error: "Enter the six-digit verification code." });
        return true;
      }
      if (!allowRequest(`verify-ip:${getClientIp(req)}`, 20, 15 * 60 * 1000) ||
          !allowRequest(`verify-phone:${phone}`, 8, 15 * 60 * 1000)) {
        json(res, 429, { error: "Too many attempts. Request a new code later." });
        return true;
      }

      const client = await pool.connect();
      let sessionToken;
      let user;
      try {
        await client.query("BEGIN");
        const challengeResult = await client.query(
          `SELECT id, code_hash, attempts FROM otp_challenges
           WHERE phone_e164 = $1 AND consumed_at IS NULL AND expires_at > NOW()
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [phone]
        );
        const challenge = challengeResult.rows[0];
        if (!challenge || challenge.attempts >= 5) {
          await client.query("ROLLBACK");
          json(res, 400, { error: "Code is invalid or expired. Request a new one." });
          return true;
        }
        const valid = await verifyOtp(phone, code, challenge.code_hash, process.env.OTP_HASH_SECRET);
        await client.query(
          "UPDATE otp_challenges SET attempts = attempts + 1, consumed_at = CASE WHEN $2 THEN NOW() ELSE consumed_at END WHERE id = $1",
          [challenge.id, valid]
        );
        if (!valid) {
          await client.query("COMMIT");
          json(res, 400, { error: "Code is invalid or expired." });
          return true;
        }

        const userResult = await client.query(
          `INSERT INTO users (phone_e164, phone_verified_at)
           VALUES ($1, NOW())
           ON CONFLICT (phone_e164) DO UPDATE SET phone_verified_at = COALESCE(users.phone_verified_at, NOW()), updated_at = NOW()
           RETURNING id, phone_e164, display_name, username, avatar_url`,
          [phone]
        );
        user = userResult.rows[0];
        sessionToken = createSessionToken();
        await client.query(
          "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
          [user.id, hashSessionToken(sessionToken)]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
      const cookie = `lovemet_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
      json(res, 200, { ok: true, user }, { "Set-Cookie": cookie });
      return true;
    }

    if (pathname === "/api/auth/me" && req.method === "GET") {
      const user = await currentUser(req);
      json(res, user ? 200 : 401, user ? { user } : { error: "Not signed in." });
      return true;
    }

    if (pathname === "/api/profile" && req.method === "PATCH") {
      const user = await currentUser(req);
      if (!user) {
        json(res, 401, { error: "Sign in to edit your profile." });
        return true;
      }
      const body = await readJson(req);
      const displayName = body.displayName === undefined ? user.display_name : String(body.displayName).trim();
      const username = body.username === undefined ? user.username : String(body.username).trim().toLowerCase();
      if (displayName !== null && displayName !== undefined && (displayName.length < 1 || displayName.length > 40)) {
        json(res, 400, { error: "Display name must be 1–40 characters." });
        return true;
      }
      if (username !== null && username !== undefined && !/^[a-z0-9_]{3,20}$/.test(username)) {
        json(res, 400, { error: "Username must be 3–20 characters using lowercase letters, numbers or underscores." });
        return true;
      }
      try {
        const updated = await pool.query(
          `UPDATE users SET display_name = $2, username = $3, updated_at = NOW()
           WHERE id = $1
           RETURNING id, phone_e164, display_name, username, avatar_url`,
          [user.id, displayName || null, username || null]
        );
        json(res, 200, { user: updated.rows[0] });
      } catch (error) {
        if (error.code === "23505") {
          json(res, 409, { error: "That username is already in use." });
          return true;
        }
        throw error;
      }
      return true;
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const token = readCookie(req, "lovemet_session");
      if (token) {
        await pool.query("UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL", [hashSessionToken(token)]);
      }
      json(res, 200, { ok: true }, { "Set-Cookie": cookieOptions(req, 0) });
      return true;
    }

    json(res, 404, { error: "Unknown authentication endpoint." });
    return true;
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error("LoveMet auth error:", error.message);
    json(res, status, { error: status === 500 ? "Authentication service error." : error.message });
    return true;
  }
}

module.exports = { handleAuthRequest, pool };
