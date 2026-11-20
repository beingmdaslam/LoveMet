import { spawn } from "node:child_process";

const port = 8791;
const base = \`http://127.0.0.1:\${port}\`;
const child = spawn(process.execPath, [
  "./node_modules/wrangler/bin/wrangler.js",
  "dev",
  "--local",
  "--ip", "127.0.0.1",
  "--port", String(port),
  "--inspector-port", "0"
], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });

let output = "";
child.stdout.on("data", chunk => { output += chunk.toString(); });
child.stderr.on("data", chunk => { output += chunk.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(\`Wrangler exited early:\n\${output}\`);
    try {
      const response = await fetch(base);
      if (response.status > 0) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(\`Wrangler did not become ready:\n\${output}\`);
}

try {
  await waitForServer();

  const home = await fetch(base);
  if (!home.ok) throw new Error(\`Homepage returned HTTP \${home.status}\`);
  const html = await home.text();
  if (!html.toLowerCase().includes("<!doctype html")) throw new Error("Homepage did not serve the expected HTML document");
  for (const [name, expected] of [
    ["x-frame-options", "DENY"],
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "strict-origin-when-cross-origin"]
  ]) {
    if (home.headers.get(name) !== expected) throw new Error(\`Homepage security header \${name} was not enforced\`);
  }

  const health = await fetch(\`\${base}/healthz\`);
  if (health.status !== 503) throw new Error(\`Unconfigured backend health should fail closed with HTTP 503, got \${health.status}\`);

  const chat = await fetch(\`\${base}/chat\`, { method: "POST" });
  if (chat.status !== 426) throw new Error(\`Non-WebSocket chat request should return HTTP 426, got \${chat.status}\`);

  const signal = await fetch(\`\${base}/signal\`);
  if (signal.status !== 426) throw new Error(\`Non-WebSocket signaling request should return HTTP 426, got \${signal.status}\`);

  console.log("Cloudflare local runtime smoke test passed: static assets, security headers, health fail-closed, chat and signaling guards.");
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000).unref();
  });
}
