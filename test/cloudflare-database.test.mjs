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
