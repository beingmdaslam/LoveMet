const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadFetchHandler() {
  const source = fs.readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");
  const listeners = {};
  const self = {
    location: { origin: "https://lovemet.example" },
    clients: { claim() {} },
    skipWaiting() {},
    addEventListener(name, handler) { listeners[name] = handler; }
  };
  vm.runInNewContext(source, { self, URL, caches: { match() { return Promise.resolve(undefined); } }, fetch() { return Promise.reject(new Error("offline")); } });
  return listeners.fetch;
}

test("service worker never intercepts authenticated API responses", () => {
  const onFetch = loadFetchHandler();
  let intercepted = false;
  onFetch({
    request: {
      method: "GET",
      url: "https://lovemet.example/api/messages?contactId=private",
      mode: "cors"
    },
    respondWith() { intercepted = true; }
  });
  assert.equal(intercepted, false);
});

test("service worker does not intercept signaling or non-GET requests", () => {
  const onFetch = loadFetchHandler();
  for (const request of [
    { method: "GET", url: "https://lovemet.example/signal", mode: "cors" },
    { method: "GET", url: "https://lovemet.example/chat", mode: "cors" },
    { method: "POST", url: "https://lovemet.example/api/messages", mode: "cors" }
  ]) {
    let intercepted = false;
    onFetch({ request, respondWith() { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});

test("service worker provides offline fallback only for page navigation", () => {
  const onFetch = loadFetchHandler();
  let intercepted = false;
  onFetch({
    request: { method: "GET", url: "https://lovemet.example/", mode: "navigate" },
    respondWith() { intercepted = true; }
  });
  assert.equal(intercepted, true);
});
