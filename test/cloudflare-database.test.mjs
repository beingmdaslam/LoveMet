import test from "node:test";
import assert from "node:assert/strict";
import { withDatabase } from "../cloudflare/database.mjs";

test("withDatabase uses the Hyperdrive connection string and closes the client", async () => {
  const calls = [];
  class FakeClient {
    constructor(options) { calls.push(["construct", options]); }
    async connect() { calls.push(["connect"]); }
    async query(sql) { calls.push(["query", sql]); return { rows: [{ ok: 1 }] }; }
    async end() { calls.push(["end"]); }
  }
  const result = await withDatabase(
    { HYPERDRIVE: { connectionString: "postgres://test.invalid/db" } },
    client => client.query("SELECT 1 AS ok"),
    FakeClient
  );
  assert.deepEqual(result.rows, [{ ok: 1 }]);
  assert.deepEqual(calls.map(call => call[0]), ["construct", "connect", "query", "end"]);
  assert.equal(calls[0][1].connectionString, "postgres://test.invalid/db");
});

test("withDatabase closes the client when the query callback throws", async () => {
  let ended = false;
  class FakeClient {
    async connect() {}
    async end() { ended = true; }
  }
  await assert.rejects(
    withDatabase({ HYPERDRIVE: { connectionString: "postgres://test.invalid/db" } },
      async () => { throw new Error("query failed"); }, FakeClient),
    /query failed/
  );
  assert.equal(ended, true);
});

test("withDatabase rejects a missing Hyperdrive binding without opening a connection", async () => {
  let constructed = false;
  class FakeClient { constructor() { constructed = true; } }
  await assert.rejects(withDatabase({}, async () => {}, FakeClient), /Hyperdrive binding is not configured/);
  assert.equal(constructed, false);
});

test("withDatabase does not call end when connect itself fails", async () => {
  let ended = false;
  class FakeClient {
    async connect() { throw new Error("connect failed"); }
    async end() { ended = true; }
  }
  await assert.rejects(
    withDatabase({ HYPERDRIVE: { connectionString: "postgres://test.invalid/db" } },
      async () => {}, FakeClient),
    /connect failed/
  );
  assert.equal(ended, false);
});

test("schema readiness requires the full app schema and nullable phone plus email OTP", async () => {
  let sql = "";
  const ready = await (await import("../cloudflare/database.mjs")).isSchemaReady({
    async query(statement) { sql = statement; return { rows: [{ ready: true }] }; }
  });
  assert.equal(ready, true);
  for (const required of ["public.users", "public.email_otp_challenges", "public.sessions", "public.call_invites", "public.api_rate_limits", "email_verified_at", "is_nullable = 'YES'", "users_email_unique_idx", "phone_e164%", "relrowsecurity = TRUE"]) {
    assert.ok(sql.includes(required), "readiness query must check " + required);
  }
});

test("schema readiness stays false until the email OTP migration is applied", async () => {
  const ready = await (await import("../cloudflare/database.mjs")).isSchemaReady({
    async query() { return { rows: [{ ready: false }] }; }
  });
  assert.equal(ready, false);
});
