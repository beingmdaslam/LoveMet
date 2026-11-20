const test = require("node:test");
const assert = require("node:assert/strict");

const { default: worker } = await import("../cloudflare/worker.mjs");

function assets(response = new Response("static app", { status: 200 })) {
  return { ASSETS: { fetch: async request => {
    assert.ok(request instanceof Request);
    return response;
  } } };
}

test("Cloudflare preview delegates public files to Static Assets", async () => {
  const response = await worker.fetch(new Request("https://example.test/"), assets());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "static app");
});

test("Cloudflare preview fails closed for API routes until migration is complete", async () => {
  for (const pathname of ["/api", "/api/auth/me", "/api/messages"]) {
    const response = await worker.fetch(new Request(`https://example.test${pathname}`), assets());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal((await response.json()).error, "service_unavailable");
  }
});

test("Cloudflare preview does not claim backend health before database integration", async () => {
  const response = await worker.fetch(new Request("https://example.test/healthz"), assets());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "service_unavailable");
});

test("Cloudflare preview refuses chat and signaling sockets until Durable Objects are ready", async () => {
  for (const pathname of ["/chat", "/signal"]) {
    const response = await worker.fetch(new Request(`https://example.test${pathname}`, {
      headers: { Upgrade: "websocket" }
    }), assets());
    assert.equal(response.status, 503);
  }
});

test("Cloudflare preview reports missing static asset binding safely", async () => {
  const response = await worker.fetch(new Request("https://example.test/"), {});
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
