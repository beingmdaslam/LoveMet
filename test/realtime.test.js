const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const WebSocket = require("ws");
const { addClient, publishMessage, publishReadReceipt } = require("../src/realtime");

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


test("read receipts are sent only to the original message sender", () => {
  const sender = new FakeSocket();
  const recipient = new FakeSocket();
  addClient("receipt-test-sender", sender);
  addClient("receipt-test-recipient", recipient);
  publishReadReceipt("receipt-test-sender", "receipt-test-recipient", ["m1", "m2"], "2026-11-20T00:00:00.000Z");
  assert.equal(sender.sent.length, 1);
  assert.equal(recipient.sent.length, 0);
  assert.deepEqual(sender.sent[0], {
    type: "read",
    contactId: "receipt-test-recipient",
    messageIds: ["m1", "m2"],
    readAt: "2026-11-20T00:00:00.000Z"
  });
  sender.emit("close");
  recipient.emit("close");
});
