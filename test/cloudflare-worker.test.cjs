const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

async function getWorker() { return (await import("../cloudflare/worker.mjs")).default; }

function assets(response = new Response("static app", { status: 200 })) {
  return { ASSETS: { fetch: async request => {
    assert.ok(request instanceof Request);
    return response;
  } } };
}

test("Cloudflare preview delegates public files to Static Assets", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(new Request("https://example.test/"), assets());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "static app");
});

test("Cloudflare preview fails closed for API routes until migration is complete", async () => {
  const worker = await getWorker();
  for (const pathname of ["/api", "/api/auth/me", "/api/messages"]) {
    const response = await worker.fetch(new Request(`https://example.test${pathname}`), assets());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal((await response.json()).error, "service_unavailable");
  }
});

test("Cloudflare preview does not claim backend health before database integration", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(new Request("https://example.test/healthz"), assets());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "service_unavailable");
});

test("Cloudflare preview refuses chat and signaling sockets until Durable Objects are ready", async () => {
  const worker = await getWorker();
  for (const pathname of ["/chat", "/signal?roomId=11111111-1111-4111-8111-111111111111"]) {
    const response = await worker.fetch(new Request(`https://example.test${pathname}`, {
      headers: { Upgrade: "websocket" }
    }), assets());
    assert.equal(response.status, 503);
  }
});

test("Cloudflare preview reports missing static asset binding safely", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(new Request("https://example.test/"), {});
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});


test("Cloudflare static assets receive baseline browser security headers", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(new Request("https://example.test/"), assets());
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(response.headers.get("permissions-policy"), "camera=(self), microphone=(self), geolocation=()");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(await response.text(), "static app");
});

test("Wrangler config declares separate SQLite-backed call and user-event Durable Objects", () => {
  const config = JSON.parse(fs.readFileSync(new URL("../wrangler.jsonc", "file://" + __filename), "utf8"));
  assert.equal(config.main, "./cloudflare/worker.mjs");
  assert.equal(config.assets.binding, "ASSETS");
  assert.deepEqual(config.durable_objects.bindings.map(binding => binding.name), ["CALL_ROOMS", "USER_EVENTS"]);
  assert.deepEqual(config.migrations.map(migration => migration.tag), ["v1", "v2"]);
  assert.deepEqual(config.migrations[0].new_sqlite_classes, ["CallRooms"]);
  assert.deepEqual(config.migrations[1].new_sqlite_classes, ["UserEvents"]);
});

test("Cloudflare Worker rejects malformed UUID-shaped signaling room IDs", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(new Request("https://example.test/signal?roomId=111111111111111111111111111111111111", {
    headers: { Upgrade: "websocket" }
  }), { CALL_ROOMS: { idFromName() { throw new Error("must not allocate a room"); } } });
  assert.equal(response.status, 400);
});

test("Cloudflare Worker rejects non-WebSocket signaling requests before Durable Object lookup", async () => {
  const worker = await getWorker();
  let lookups = 0;
  const env = { CALL_ROOMS: { idFromName() { lookups += 1; throw new Error("must not allocate a room"); } } };
  const roomId = "11111111-1111-4111-8111-111111111111";
  const methodResponse = await worker.fetch(new Request(`https://example.test/signal?roomId=${roomId}`, {
    method: "POST",
    headers: { Upgrade: "websocket" }
  }), env);
  assert.equal(methodResponse.status, 426);
  const upgradeResponse = await worker.fetch(new Request(`https://example.test/signal?roomId=${roomId}`), env);
  assert.equal(upgradeResponse.status, 426);
  assert.equal(lookups, 0);
});

test("Cloudflare Worker rejects non-WebSocket chat requests before database or Durable Object access", async () => {
  const worker = await getWorker();
  let databaseCalls = 0;
  let objectLookups = 0;
  const env = {
    HYPERDRIVE: { connectionString: "postgres://unused" },
    USER_EVENTS: { idFromName() { objectLookups += 1; throw new Error("must not look up a user room"); } }
  };
  for (const request of [
    new Request("https://example.test/chat", { method: "POST", headers: { Upgrade: "websocket" } }),
    new Request("https://example.test/chat")
  ]) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 426);
    assert.equal(response.headers.get("content-type"), "text/plain;charset=UTF-8");
  }
  assert.equal(databaseCalls, 0);
  assert.equal(objectLookups, 0);
});

test("Cloudflare Worker rejects missing signaling room IDs before Durable Object lookup", async () => {
  const worker = await getWorker();
  let lookups = 0;
  const response = await worker.fetch(new Request("https://example.test/signal", {
    headers: { Upgrade: "websocket" }
  }), { CALL_ROOMS: { idFromName() { lookups += 1; throw new Error("must not allocate a room"); } } });
  assert.equal(response.status, 400);
  assert.equal(lookups, 0);
});