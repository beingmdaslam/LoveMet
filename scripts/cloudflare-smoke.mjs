import { spawn } from "node:child_process";

const port = 8791;
const base = "http://127.0.0.1:" + port;
const child = spawn(process.execPath, [
  "./node_modules/wrangler/bin/wrangler.js",
  "dev", "--local", "--ip", "127.0.0.1",
  "--port", String(port), "--inspector-port", "0"
], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });

let output = "";
child.stdout.on("data", chunk => { output += chunk.toString(); });
child.stderr.on("data", chunk => { output += chunk.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Wrangler exited early:\n" + output);
    try {
      const response = await fetch(base);
      if (response.status > 0) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Wrangler did not become ready:\n" + output);
}

try {
  await waitForServer();
  const home = await fetch(base);
  if (!home.ok) throw new Error("Homepage returned HTTP " + home.status);
  const html = await home.text();
  if (!html.toLowerCase().includes("<!doctype html")) throw new Error("Homepage did not serve the expected HTML document");
  for (const [name, expected] of [
    ["x-frame-options", "DENY"],
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"]
  ]) {
    if (home.headers.get(name) !== expected) throw new Error("Homepage security header " + name + " was not enforced");
  }
  const manifestResponse = await fetch(base + "/manifest.webmanifest");
  if (!manifestResponse.ok) throw new Error("PWA manifest returned HTTP " + manifestResponse.status);
  const manifest = await manifestResponse.json();
  if (manifest.start_url !== "/" || manifest.scope !== "/" || !Array.isArray(manifest.icons) || !manifest.icons.length) {
    throw new Error("PWA manifest is missing its app shell metadata or icons");
  }
  const serviceWorker = await fetch(base + "/sw.js");
  if (!serviceWorker.ok) throw new Error("Service worker returned HTTP " + serviceWorker.status);
  const swSource = await serviceWorker.text();
  if (!swSource.includes("/manifest.webmanifest") || !swSource.includes("/lovemet-icon.svg")) {
    throw new Error("Service worker app shell does not include the manifest and app icon");
  }
  const icon = await fetch(base + "/lovemet-icon.svg");
  if (!icon.ok || !(icon.headers.get("content-type") || "").includes("image/svg+xml")) {
    throw new Error("PWA app icon is missing or has an unexpected content type");
  }
  const health = await fetch(base + "/healthz");
  if (health.status !== 503) throw new Error("Unconfigured backend health should fail closed with HTTP 503, got " + health.status);
  const chat = await fetch(base + "/chat", { method: "POST" });
  if (chat.status !== 426) throw new Error("Non-WebSocket chat request should return HTTP 426, got " + chat.status);
  const signal = await fetch(base + "/signal");
  if (signal.status !== 426) throw new Error("Non-WebSocket signaling request should return HTTP 426, got " + signal.status);
  console.log("Cloudflare local runtime smoke test passed: static assets, PWA shell, security headers, health fail-closed, chat and signaling guards.");
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000).unref();
  });
}
