const test = require("node:test");
const assert = require("node:assert/strict");

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
