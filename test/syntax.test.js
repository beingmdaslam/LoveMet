const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

test("server and backend JavaScript files parse", () => {
  const files = [
    "server.js",
    "src/auth.js",
    "src/security.js",
    "src/realtime.js",
    "src/social.js",
    "public/sw.js"
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), file);
  }
});

test("all inline browser scripts parse", () => {
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, "expected inline browser scripts");
  scripts.forEach((match, index) => {
    assert.doesNotThrow(
      () => new vm.Script(match[1], { filename: "public/index.html inline script " + index }),
      "inline script " + index
    );
  });
});
