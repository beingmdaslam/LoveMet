const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const rooms = new Map();

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
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
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server, path: "/signal", maxPayload: 64 * 1024 });

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

wss.on("connection", (ws) => {
  ws.roomId = null;

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid message format." });
      return;
    }

    if (message.type === "join") {
      const roomId = String(message.roomId || "").trim().toUpperCase();
      if (!/^[A-Z0-9-]{4,24}$/.test(roomId)) {
        send(ws, { type: "error", message: "Room code must be 4–24 letters or numbers." });
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
