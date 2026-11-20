const { pool } = require("./auth");

const MAX_BODY_BYTES = 8 * 1024;

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(body));
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ""; }
  }
  return "";
}

async function getUser(req) {
  const token = readCookie(req, "lovemet_session");
  if (!pool || !token || token.length > 200) return null;
  const crypto = require("node:crypto");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const result = await pool.query(
    `SELECT u.id, u.phone_e164, u.display_name, u.username, u.avatar_url
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw Object.assign(new Error("Request too large."), { status: 413 });
  }
  try {
    const body = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
}

async function isContact(userA, userB) {
  const result = await pool.query(
    `SELECT 1 FROM contact_requests
     WHERE status = 'accepted'
       AND ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1))
     LIMIT 1`,
    [userA, userB]
  );
  return result.rowCount > 0;
}

async function handleSocialRequest(req, res, pathname) {
  if (!pathname.startsWith("/api/contacts") && pathname !== "/api/users/search" && pathname !== "/api/messages") return false;
  if (!pool) {
    json(res, 503, { error: "Account service is not configured." });
    return true;
  }

  try {
    const user = await getUser(req);
    if (!user) {
      json(res, 401, { error: "Sign in to continue." });
      return true;
    }

    if (pathname === "/api/users/search" && req.method === "GET") {
      const term = String(new URL(req.url, "http://localhost").searchParams.get("username") || "")
        .trim().toLowerCase().replace(/^@/, "");
      if (!/^[a-z0-9_]{3,20}$/.test(term)) {
        json(res, 400, { error: "Enter a username with 3–20 letters, numbers or underscores." });
        return true;
      }
      const result = await pool.query(
        `SELECT id, username, display_name, avatar_url FROM users
         WHERE username LIKE $1 AND id <> $2 LIMIT 10`,
        [term + "%", user.id]
      );
      json(res, 200, { users: result.rows });
      return true;
    }

    if (pathname === "/api/contacts" && req.method === "GET") {
      const result = await pool.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url
         FROM contact_requests c
         JOIN users u ON u.id = CASE WHEN c.requester_id = $1 THEN c.recipient_id ELSE c.requester_id END
         WHERE c.status = 'accepted' AND (c.requester_id = $1 OR c.recipient_id = $1)
         ORDER BY u.username NULLS LAST, u.display_name NULLS LAST`,
        [user.id]
      );
      json(res, 200, { contacts: result.rows });
      return true;
    }

    if (pathname === "/api/contacts/requests" && req.method === "GET") {
      const result = await pool.query(
        `SELECT c.id, c.created_at, u.id AS user_id, u.username, u.display_name, u.avatar_url
         FROM contact_requests c JOIN users u ON u.id = c.requester_id
         WHERE c.recipient_id = $1 AND c.status = 'pending'
         ORDER BY c.created_at DESC LIMIT 50`,
        [user.id]
      );
      json(res, 200, { requests: result.rows });
      return true;
    }

    if (pathname === "/api/contacts/request" && req.method === "POST") {
      const body = await readJson(req);
      const username = String(body.username || "").trim().toLowerCase().replace(/^@/, "");
      if (!/^[a-z0-9_]{3,20}$/.test(username)) {
        json(res, 400, { error: "Enter a valid username." });
        return true;
      }
      const target = await pool.query("SELECT id FROM users WHERE username = $1 LIMIT 1", [username]);
      if (!target.rowCount) {
        json(res, 404, { error: "User not found." });
        return true;
      }
      if (target.rows[0].id === user.id) {
        json(res, 400, { error: "You cannot add yourself." });
        return true;
      }
      try {
        const created = await pool.query(
          `INSERT INTO contact_requests (requester_id, recipient_id)
           VALUES ($1, $2) RETURNING id, status, created_at`,
          [user.id, target.rows[0].id]
        );
        json(res, 201, { request: created.rows[0] });
      } catch (error) {
        if (error.code === "23505") {
          json(res, 409, { error: "A request already exists between these accounts." });
          return true;
        }
        throw error;
      }
      return true;
    }

    if (pathname === "/api/contacts/respond" && req.method === "POST") {
      const body = await readJson(req);
      const requestId = String(body.requestId || "");
      const action = String(body.action || "");
      if (!/^[0-9a-f-]{36}$/i.test(requestId) || !["accept", "decline"].includes(action)) {
        json(res, 400, { error: "Provide a valid requestId and accept or decline action." });
        return true;
      }
      const result = await pool.query(
        `UPDATE contact_requests SET status = $3, updated_at = NOW()
         WHERE id = $1 AND recipient_id = $2 AND status = 'pending'
         RETURNING id, status`,
        [requestId, user.id, action === "accept" ? "accepted" : "declined"]
      );
      if (!result.rowCount) {
        json(res, 404, { error: "Pending contact request not found." });
        return true;
      }
      json(res, 200, { request: result.rows[0] });
      return true;
    }

    if (pathname === "/api/messages" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const contactId = String(url.searchParams.get("contactId") || "");
      if (!/^[0-9a-f-]{36}$/i.test(contactId) || !(await isContact(user.id, contactId))) {
        json(res, 403, { error: "Messages are available only with accepted contacts." });
        return true;
      }
      const result = await pool.query(
        `SELECT id, sender_id, recipient_id, body, created_at, delivered_at, read_at
         FROM messages
         WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
         ORDER BY created_at DESC LIMIT 50`,
        [user.id, contactId]
      );
      json(res, 200, { messages: result.rows.reverse() });
      return true;
    }

    if (pathname === "/api/messages" && req.method === "POST") {
      const body = await readJson(req);
      const contactId = String(body.contactId || "");
      const message = String(body.message || "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(contactId) || message.length < 1 || message.length > 4000) {
        json(res, 400, { error: "Provide a contact and a message of 1–4000 characters." });
        return true;
      }
      if (!(await isContact(user.id, contactId))) {
        json(res, 403, { error: "You can message accepted contacts only." });
        return true;
      }
      const result = await pool.query(
        `INSERT INTO messages (sender_id, recipient_id, body)
         VALUES ($1, $2, $3)
         RETURNING id, sender_id, recipient_id, body, created_at, delivered_at, read_at`,
        [user.id, contactId, message]
      );
      json(res, 201, { message: result.rows[0] });
      return true;
    }

    json(res, 404, { error: "Unknown social endpoint." });
    return true;
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error("LoveMet social API error:", error.message);
    json(res, status, { error: status >= 500 ? "Social service error." : error.message });
    return true;
  }
}

module.exports = { handleSocialRequest };
