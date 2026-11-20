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
       AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = $1))
     LIMIT 1`,
    [userA, userB]
  );
  return result.rowCount > 0;
}

async function handleSocialRequest(req, res, pathname) {
  if (!pathname.startsWith("/api/contacts") && !pathname.startsWith("/api/calls") && pathname !== "/api/users/search" && pathname !== "/api/users/report" && pathname !== "/api/messages") return false;
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
         WHERE username LIKE $1 AND id <> $2
           AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = users.id) OR (b.blocker_id = users.id AND b.blocked_id = $2))
         LIMIT 10`,
        [term + "%", user.id]
      );
      json(res, 200, { users: result.rows });
      return true;
    }

    if (pathname === "/api/contacts/blocks" && req.method === "GET") {
      const result = await pool.query(
        `SELECT u.id, u.username, u.display_name, b.created_at
         FROM user_blocks b JOIN users u ON u.id = b.blocked_id
         WHERE b.blocker_id = $1 ORDER BY b.created_at DESC LIMIT 100`,
        [user.id]
      );
      json(res, 200, { blocks: result.rows });
      return true;
    }

    if (pathname === "/api/contacts/block" && req.method === "POST") {
      const body = await readJson(req);
      const targetId = String(body.userId || "");
      if (!/^[0-9a-f-]{36}$/i.test(targetId) || targetId === user.id) {
        json(res, 400, { error: "Provide a valid user to block." });
        return true;
      }
      const target = await pool.query("SELECT id FROM users WHERE id = $1", [targetId]);
      if (!target.rowCount) {
        json(res, 404, { error: "User not found." });
        return true;
      }
      await pool.query(
        "INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [user.id, targetId]
      );
      await pool.query(
        `UPDATE call_invites SET status = 'ended', updated_at = NOW(), ended_at = NOW()
         WHERE status IN ('ringing','accepted')
           AND ((caller_id = $1 AND callee_id = $2) OR (caller_id = $2 AND callee_id = $1))`,
        [user.id, targetId]
      );
      json(res, 200, { ok: true });
      return true;
    }

    if (pathname === "/api/contacts/unblock" && req.method === "POST") {
      const body = await readJson(req);
      const targetId = String(body.userId || "");
      if (!/^[0-9a-f-]{36}$/i.test(targetId)) {
        json(res, 400, { error: "Provide a valid user to unblock." });
        return true;
      }
      const result = await pool.query(
        "DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING blocked_id",
        [user.id, targetId]
      );
      json(res, 200, { ok: true, unblocked: result.rowCount > 0 });
      return true;
    }

    if (pathname === "/api/users/report" && req.method === "POST") {
      const body = await readJson(req);
      const targetId = String(body.userId || "");
      const reason = String(body.reason || "");
      const details = String(body.details || "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(targetId) || targetId === user.id ||
          !["harassment","spam","impersonation","inappropriate","other"].includes(reason) ||
          details.length < 1 || details.length > 1000) {
        json(res, 400, { error: "Provide a user, report reason, and details up to 1000 characters." });
        return true;
      }
      const recent = await pool.query(
        "SELECT COUNT(*)::INTEGER AS total FROM user_reports WHERE reporter_id = $1 AND created_at > NOW() - INTERVAL '24 hours'",
        [user.id]
      );
      if (recent.rows[0].total >= 5) {
        json(res, 429, { error: "Daily report limit reached." });
        return true;
      }
      const target = await pool.query("SELECT id FROM users WHERE id = $1", [targetId]);
      if (!target.rowCount) {
        json(res, 404, { error: "User not found." });
        return true;
      }
      const report = await pool.query(
        `INSERT INTO user_reports (reporter_id, reported_id, reason, details)
         VALUES ($1, $2, $3, $4) RETURNING id, status, created_at`,
        [user.id, targetId, reason, details]
      );
      json(res, 201, { report: report.rows[0] });
      return true;
    }

    if (pathname === "/api/contacts" && req.method === "GET") {
      const result = await pool.query(
        `SELECT u.id, u.username, u.display_name, u.avatar_url
         FROM contact_requests c
         JOIN users u ON u.id = CASE WHEN c.requester_id = $1 THEN c.recipient_id ELSE c.requester_id END
         WHERE c.status = 'accepted' AND (c.requester_id = $1 OR c.recipient_id = $1)
           AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))
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
           AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))
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
      const blocked = await pool.query(
        "SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1",
        [user.id, target.rows[0].id]
      );
      if (blocked.rowCount) {
        json(res, 403, { error: "Contact requests are unavailable between these accounts." });
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
           AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $2 AND b.blocked_id = contact_requests.requester_id) OR (b.blocker_id = contact_requests.requester_id AND b.blocked_id = $2))
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

    if (pathname === "/api/calls/config" && req.method === "GET") {
      const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
      const turnUrls = String(process.env.TURN_URLS || "").split(",").map(value => value.trim()).filter(value => /^(turn|turns):/i.test(value));
      const sharedSecret = process.env.TURN_SHARED_SECRET || "";
      if (turnUrls.length && sharedSecret.length >= 32) {
        const expiresAt = Math.floor(Date.now() / 1000) + 600;
        const username = expiresAt + ":" + user.id;
        const credential = require("node:crypto").createHmac("sha1", sharedSecret).update(username).digest("base64");
        iceServers.push({ urls: turnUrls, username, credential });
      }
      json(res, 200, { iceServers });
      return true;
    }

    if (pathname === "/api/calls/status" && req.method === "GET") {
      const inviteId = String(new URL(req.url, "http://localhost").searchParams.get("inviteId") || "");
      if (!/^[0-9a-f-]{36}$/i.test(inviteId)) {
        json(res, 400, { error: "Provide a valid call invitation." });
        return true;
      }
      await pool.query(
        `UPDATE call_invites SET status = 'ended', updated_at = NOW(), ended_at = NOW()
         WHERE id = $1 AND status = 'accepted' AND expires_at <= NOW()
           AND (caller_id = $2 OR callee_id = $2)`,
        [inviteId, user.id]
      );
      const result = await pool.query(
        `SELECT id, status, expires_at FROM call_invites
         WHERE id = $1 AND (caller_id = $2 OR callee_id = $2) LIMIT 1`,
        [inviteId, user.id]
      );
      if (!result.rowCount) {
        json(res, 404, { error: "Call invitation not found." });
        return true;
      }
      json(res, 200, { status: result.rows[0].status, expiresAt: result.rows[0].expires_at });
      return true;
    }

    if (pathname === "/api/calls/history" && req.method === "GET") {
      const result = await pool.query(
        `SELECT c.id, c.status, c.created_at, c.started_at, c.ended_at,
                CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END AS contact_id,
                u.username AS contact_username, u.display_name AS contact_display_name,
                CASE WHEN c.started_at IS NOT NULL AND c.ended_at IS NOT NULL
                     THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (c.ended_at - c.started_at))))::INTEGER
                     ELSE NULL END AS duration_seconds,
                (c.caller_id = $1) AS outgoing
         FROM call_invites c
         JOIN users u ON u.id = CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END
         WHERE c.caller_id = $1 OR c.callee_id = $1
         ORDER BY c.created_at DESC LIMIT 30`,
        [user.id]
      );
      json(res, 200, { calls: result.rows });
      return true;
    }

    if (pathname === "/api/calls/invites" && req.method === "GET") {
      await pool.query(
        `UPDATE call_invites SET status = 'missed', updated_at = NOW(), ended_at = NOW()
         WHERE (callee_id = $1 OR caller_id = $1) AND status = 'ringing' AND expires_at <= NOW()`,
        [user.id]
      );
      await pool.query(
        `UPDATE call_invites SET status = 'ended', updated_at = NOW(), ended_at = NOW()
         WHERE (caller_id = $1 OR callee_id = $1) AND status = 'accepted' AND expires_at <= NOW()`,
        [user.id]
      );
      const result = await pool.query(
        `SELECT c.id, c.caller_id, c.callee_id, c.status, c.created_at, c.expires_at,
                caller.username AS caller_username, caller.display_name AS caller_display_name,
                callee.username AS callee_username, callee.display_name AS callee_display_name
         FROM call_invites c
         JOIN users caller ON caller.id = c.caller_id
         JOIN users callee ON callee.id = c.callee_id
         WHERE (c.callee_id = $1 AND c.status = 'ringing' AND c.expires_at > NOW())
            OR (c.caller_id = $1 AND c.created_at > NOW() - INTERVAL '1 day')
         ORDER BY c.created_at DESC LIMIT 20`,
        [user.id]
      );
      json(res, 200, { invites: result.rows });
      return true;
    }

    if (pathname === "/api/calls/invite" && req.method === "POST") {
      const body = await readJson(req);
      const contactId = String(body.contactId || "");
      if (!/^[0-9a-f-]{36}$/i.test(contactId) || !(await isContact(user.id, contactId))) {
        json(res, 403, { error: "Calls are available only with accepted contacts." });
        return true;
      }
      await pool.query(
        `UPDATE call_invites SET status = 'ended', updated_at = NOW(), ended_at = NOW()
         WHERE status IN ('ringing','accepted') AND expires_at <= NOW()
           AND ((caller_id = $1 AND callee_id = $2) OR (caller_id = $2 AND callee_id = $1))`,
        [user.id, contactId]
      );
      const recentCalls = await pool.query(
        `SELECT COUNT(*)::INTEGER AS total FROM call_invites
         WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
        [user.id]
      );
      if (recentCalls.rows[0].total >= 20) {
        json(res, 429, { error: "Call invitation limit reached. Try again later." });
        return true;
      }
      const active = await pool.query(
        `SELECT id FROM call_invites
         WHERE status IN ('ringing','accepted') AND expires_at > NOW()
           AND ((caller_id = $1 AND callee_id = $2) OR (caller_id = $2 AND callee_id = $1))
         LIMIT 1`,
        [user.id, contactId]
      );
      if (active.rowCount) {
        json(res, 409, { error: "A call with this contact is already active." });
        return true;
      }
      try {
        const created = await pool.query(
          `INSERT INTO call_invites (caller_id, callee_id)
           VALUES ($1, $2)
           RETURNING id, caller_id, callee_id, status, created_at, expires_at`,
          [user.id, contactId]
        );
        json(res, 201, { invite: created.rows[0] });
      } catch (error) {
        if (error.code === "23505") {
          json(res, 409, { error: "A call with this contact is already active." });
          return true;
        }
        throw error;
      }
      return true;
    }

    if (pathname === "/api/calls/respond" && req.method === "POST") {
      const body = await readJson(req);
      const inviteId = String(body.inviteId || "");
      const action = String(body.action || "");
      if (!/^[0-9a-f-]{36}$/i.test(inviteId) || !["accept","decline","cancel","end"].includes(action)) {
        json(res, 400, { error: "Provide a valid inviteId and call action." });
        return true;
      }
      let result;
      if (action === "accept" || action === "decline") {
        result = await pool.query(
          `UPDATE call_invites SET status = $3, updated_at = NOW(), expires_at = CASE WHEN $3 = 'accepted' THEN NOW() + INTERVAL '4 hours' ELSE expires_at END, started_at = CASE WHEN $3 = 'accepted' THEN NOW() ELSE started_at END, ended_at = CASE WHEN $3 = 'declined' THEN NOW() ELSE ended_at END
           WHERE id = $1 AND callee_id = $2 AND status = 'ringing' AND expires_at > NOW()
           RETURNING id, caller_id, callee_id, status, expires_at`,
          [inviteId, user.id, action === "accept" ? "accepted" : "declined"]
        );
      } else if (action === "cancel") {
        result = await pool.query(
          `UPDATE call_invites SET status = 'cancelled', updated_at = NOW(), ended_at = NOW()
           WHERE id = $1 AND caller_id = $2 AND status = 'ringing'
           RETURNING id, caller_id, callee_id, status`,
          [inviteId, user.id]
        );
      } else {
        result = await pool.query(
          `UPDATE call_invites SET status = 'ended', updated_at = NOW(), ended_at = NOW()
           WHERE id = $1 AND (caller_id = $2 OR callee_id = $2) AND status = 'accepted'
           RETURNING id, caller_id, callee_id, status`,
          [inviteId, user.id]
        );
      }
      if (!result.rowCount) {
        json(res, 404, { error: "Active call invitation not found." });
        return true;
      }
      json(res, 200, { invite: result.rows[0] });
      return true;
    }

    if (pathname === "/api/messages" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const contactId = String(url.searchParams.get("contactId") || "");
      if (!/^[0-9a-f-]{36}$/i.test(contactId) || !(await isContact(user.id, contactId))) {
        json(res, 403, { error: "Messages are available only with accepted contacts." });
        return true;
      }
      await pool.query(
        `UPDATE messages
         SET delivered_at = COALESCE(delivered_at, NOW()), read_at = NOW()
         WHERE sender_id = $2 AND recipient_id = $1 AND read_at IS NULL`,
        [user.id, contactId]
      );
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

module.exports = { handleSocialRequest, getUser };
