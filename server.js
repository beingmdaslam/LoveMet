const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { handleAuthRequest, pool } = require("./src/auth");
const { handleSocialRequest, getUser } = require("./src/social");
const { addClient } = require("./src/realtime");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const rooms = new Map();
const CALL_RECONNECT_GRACE_MS = 25000;

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (await handleAuthRequest(req, res, pathname)) return;
  if (await handleSocialRequest(req, res, pathname)) return;
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, requested);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".json": "application/json; charset=utf-8" };
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()"
    });
    res.end(data);
  });
});

const chatWss = new WebSocket.Server({ server, path: "/chat", maxPayload: 1024, perMessageDeflate: false });

chatWss.on("connection", async (ws, req) => {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  let originAllowed = false;
  try {
    const origin = new URL(req.headers.origin || "");
    originAllowed = origin.host === req.headers.host && origin.protocol === (forwardedProto === "https" ? "https:" : "http:");
  } catch {}
  if (!originAllowed) { ws.close(1008, "Invalid chat origin"); return; }
  try {
    const user = await getUser(req);
    if (!user) { ws.close(1008, "Sign in required"); return; }
    if (!addClient(user.id, ws)) { ws.close(1013, "Too many chat connections"); return; }
    let verificationFailures = 0;
    const authTimer = setInterval(async () => {
      try {
        const current = await getUser(req);
        verificationFailures = 0;
        if (!current || current.id !== user.id) ws.close(1008, "Session expired");
      } catch {
        // A single transient database/network error must not kick a user out.
        // Retry on the next interval; only stop after repeated failures.
        verificationFailures += 1;
        if (verificationFailures >= 3) ws.close(1011, "Session verification unavailable");
      }
    }, 60000);
    ws.once("close", () => clearInterval(authTimer));
    ws.on("message", () => ws.close(1008, "Chat socket is receive-only"));
  } catch {
    ws.close(1011, "Chat authentication unavailable");
  }
});

const wss = new WebSocket.Server({ server, path: "/signal", maxPayload: 64 * 1024 });

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

wss.on("connection", (ws, req) => {
  ws.roomId = null;
  const origin = req.headers.origin;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  let originAllowed = false;
  try {
    const parsedOrigin = new URL(origin || "");
    originAllowed = parsedOrigin.host === req.headers.host &&
      parsedOrigin.protocol === (forwardedProto === "https" ? "https:" : "http:");
  } catch {}
  if (!originAllowed) {
    ws.close(1008, "Invalid signaling origin");
    return;
  }
  let authCheckInFlight = false;
  let authVerificationFailures = 0;
  let authTimer = null;
  ws.authPromise = getUser(req).then(user => {
    ws.authUser = user;
    if (!user) {
      ws.close(1008, "Sign in required");
      return null;
    }
    // Revalidate the session periodically so logout, account deletion, or
    // session revocation also terminates an already-open signaling socket.
    authTimer = setInterval(async () => {
      if (authCheckInFlight || ws.readyState !== WebSocket.OPEN) return;
      authCheckInFlight = true;
      try {
        const current = await getUser(req);
        authVerificationFailures = 0;
        if (!current || current.id !== user.id) ws.close(1008, "Session expired");
      } catch {
        // Preserve an active call through brief database outages.
        authVerificationFailures += 1;
        if (authVerificationFailures >= 3) ws.close(1011, "Session verification unavailable");
      } finally {
        authCheckInFlight = false;
      }
    }, 60000);
    return user;
  }).catch(() => {
    ws.close(1011, "Authentication unavailable");
    return null;
  });

  ws.on("close", () => {
    if (authTimer) clearInterval(authTimer);
  });

  ws.on("message", async (raw) => {
    const authenticatedUser = await ws.authPromise;
    if (!authenticatedUser) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid message format." });
      return;
    }

    if (message.type === "join") {
      const roomId = String(message.roomId || "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(roomId)) {
        send(ws, { type: "error", message: "Join using a valid accepted call invitation." });
        return;
      }
      if (!pool) {
        send(ws, { type: "error", message: "Call service is not configured." });
        return;
      }
      try {
        const permission = await pool.query(
          `SELECT id FROM call_invites
           WHERE id = $1 AND status = 'accepted' AND expires_at > NOW()
             AND (caller_id = $2 OR callee_id = $2)
             AND NOT EXISTS (
               SELECT 1 FROM user_blocks b
               WHERE (b.blocker_id = call_invites.caller_id AND b.blocked_id = call_invites.callee_id)
                  OR (b.blocker_id = call_invites.callee_id AND b.blocked_id = call_invites.caller_id)
             )
           LIMIT 1`,
          [roomId, ws.authUser.id]
        );
        if (!permission.rowCount) {
          send(ws, { type: "error", message: "This call is not accepted or has expired." });
          return;
        }
      } catch {
        send(ws, { type: "error", message: "Could not verify call permission." });
        return;
      }
      if (ws.roomId) {
        send(ws, { type: "error", message: "You are already in a room." });
        return;
      }

      let room = rooms.get(roomId);
      if (!room) {
        room = new Set();
        rooms.set(roomId, room);
      }
      const existingMember = [...room].find(peer => peer.authUser && peer.authUser.id === ws.authUser.id);
      if (existingMember) {
        if (existingMember.disconnected && existingMember.reconnectTimer) {
          clearTimeout(existingMember.reconnectTimer);
          room.delete(existingMember);
          ws.roomId = roomId;
          ws.isInitiator = existingMember.isInitiator;
          room.add(ws);
          send(ws, { type: "joined", roomId, isInitiator: ws.isInitiator, reconnected: true });
          for (const peer of room) {
            if (peer !== ws) send(peer, { type: "peer-rejoined" });
          }
          send(ws, { type: "peer-rejoined" });
          return;
        }
        send(ws, { type: "error", message: "This account is already connected to the call." });
        return;
      }
      if (room.size >= 2) {
        send(ws, { type: "error", message: "This room is full." });
        return;
      }

      ws.roomId = roomId;
      ws.isInitiator = room.size === 0;
      room.add(ws);
      send(ws, { type: "joined", roomId, isInitiator: ws.isInitiator });
      if (room.size === 2) {
        for (const peer of room) send(peer, { type: "peer-joined" });
      }
      return;
    }

    if (["offer", "answer", "ice", "hangup"].includes(message.type)) {
      const room = ws.roomId && rooms.get(ws.roomId);
      if (!room) {
        send(ws, { type: "error", message: "Join a room first." });
        return;
      }
      // Re-check authorization for every signaling packet so a newly blocked or ended call
      // cannot keep exchanging media negotiation data over an already-open socket.
      if (message.type !== "hangup") {
        try {
          const permission = await pool.query(
            `SELECT id FROM call_invites
             WHERE id = $1 AND status = 'accepted' AND expires_at > NOW()
               AND (caller_id = $2 OR callee_id = $2)
               AND NOT EXISTS (
                 SELECT 1 FROM user_blocks b
                 WHERE (b.blocker_id = call_invites.caller_id AND b.blocked_id = call_invites.callee_id)
                    OR (b.blocker_id = call_invites.callee_id AND b.blocked_id = call_invites.caller_id)
               )
             LIMIT 1`,
            [ws.roomId, ws.authUser.id]
          );
          if (!permission.rowCount) {
            send(ws, { type: "error", message: "This call is no longer authorized." });
            ws.close(1008, "Call authorization expired");
            return;
          }
        } catch {
          send(ws, { type: "error", message: "Could not verify call permission." });
          ws.close(1011, "Call authorization unavailable");
          return;
        }
      }
      for (const peer of room) {
        if (peer !== ws) send(peer, { type: message.type, data: message.data });
      }
    }
  });

  ws.on("close", () => {
    const roomId = ws.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || !room.has(ws)) return;

    // Keep a short-lived identity placeholder so a temporary mobile network
    // interruption can rejoin without ending the accepted call.
    room.delete(ws);
    const disconnected = {
      authUser: ws.authUser,
      roomId,
      isInitiator: ws.isInitiator,
      disconnected: true,
      readyState: WebSocket.CLOSED,
      reconnectTimer: null
    };
    room.add(disconnected);
    for (const peer of room) {
      if (peer !== disconnected) send(peer, { type: "peer-disconnected" });
    }
    disconnected.reconnectTimer = setTimeout(() => {
      if (!room.has(disconnected)) return;
      room.delete(disconnected);
      for (const peer of room) send(peer, { type: "peer-left" });
      if (room.size === 0) rooms.delete(roomId);
    }, CALL_RECONNECT_GRACE_MS);
  });
});

server.listen(PORT, () => {
  console.log(`Lovemet signaling server running on port ${PORT}`);
});
