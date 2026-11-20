const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { handleAuthRequest, pool } = require("./src/auth");
const { handleSocialRequest, getUser } = require("./src/social");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const rooms = new Map();

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
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
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
  ws.authPromise = getUser(req).then(user => {
    ws.authUser = user;
    if (!user) ws.close(1008, "Sign in required");
    return user;
  }).catch(() => {
    ws.close(1011, "Authentication unavailable");
    return null;
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
      if ([...room].some(peer => peer.authUser && peer.authUser.id === ws.authUser.id)) {
        send(ws, { type: "error", message: "This account is already connected to the call." });
        return;
      }
      if (room.size >= 2) {
        send(ws, { type: "error", message: "This room is full." });
        return;
      }

      ws.roomId = roomId;
      room.add(ws);
      send(ws, { type: "joined", roomId, isInitiator: room.size === 1 });
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
      for (const peer of room) {
        if (peer !== ws) send(peer, { type: message.type, data: message.data });
      }
    }
  });

  ws.on("close", () => {
    const room = ws.roomId && rooms.get(ws.roomId);
    if (!room) return;
    room.delete(ws);
    for (const peer of room) send(peer, { type: "peer-left" });
    if (room.size === 0) rooms.delete(ws.roomId);
  });
});

server.listen(PORT, () => {
  console.log(`Lovemet signaling server running on port ${PORT}`);
});
