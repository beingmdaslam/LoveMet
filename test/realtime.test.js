const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const WebSocket = require("ws");
const { addClient, publishMessage } = require("../src/realtime");

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = WebSocket.OPEN; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
}

test("live messages reach sender and recipient sockets but not unrelated users", () => {
  const sender = new FakeSocket();
  const recipient = new FakeSocket();
  const stranger = new FakeSocket();
  addClient("live-test-sender", sender);
  addClient("live-test-recipient", recipient);
  addClient("live-test-stranger", stranger);
  const message = {
    id: "message-live-test",
    sender_id: "live-test-sender",
    recipient_id: "live-test-recipient",
    body: "Hello"
  };
  publishMessage(message);
  assert.equal(sender.sent.length, 1);
  assert.equal(recipient.sent.length, 1);
  assert.equal(stranger.sent.length, 0);
  assert.deepEqual(sender.sent[0], { type: "message", message });
  sender.emit("close");
  recipient.emit("close");
  stranger.emit("close");
});
