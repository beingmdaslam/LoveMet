const WebSocket = require("ws");

const clients = new Map();

function addClient(userId, socket) {
  let sockets = clients.get(userId);
  if (!sockets) {
    sockets = new Set();
    clients.set(userId, sockets);
  }
  if (sockets.size >= 5) return false;
  sockets.add(socket);
  socket.once("close", () => {
    sockets.delete(socket);
    if (!sockets.size) clients.delete(userId);
  });
  return true;
}

function publishReadReceipt(senderId, recipientId, messageIds, readAt) {
  const sockets = clients.get(senderId);
  if (!sockets || !messageIds.length) return;
  const payload = JSON.stringify({ type: "read", contactId: recipientId, messageIds, readAt });
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function publishMessage(message) {
  const payload = JSON.stringify({ type: "message", message });
  for (const userId of [message.sender_id, message.recipient_id]) {
    const sockets = clients.get(userId);
    if (!sockets) continue;
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }
}

module.exports = { addClient, publishMessage, publishReadReceipt };
