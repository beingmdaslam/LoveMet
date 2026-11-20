import { withDatabase } from "./database.mjs";
import { handleAuthMe } from "./auth.mjs";
import { handleProfilePatch } from "./profile.mjs";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Permitted-Cross-Domain-Policies": "none"
};

function unavailable(service) {
  return new Response(JSON.stringify({
    error: "service_unavailable",
    message: `LoveMet ${service} is not connected in this preview yet.`
  }), {
    status: 503,
    headers: { ...JSON_HEADERS, "Retry-After": "60" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Fail closed until the Fetch-native API and Durable Object signaling
    // adapters have passed parity and integration tests.
    if (pathname === "/api/profile") {
      try {
        return await withDatabase(env, client => handleProfilePatch(request, client));
      } catch {
        return unavailable("API");
      }
    }
    if (pathname === "/api/auth/me") {
      try {
        return await withDatabase(env, client => handleAuthMe(request, client));
      } catch {
        return unavailable("API");
      }
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return unavailable("API");
    }
    if (pathname === "/healthz") {
      try {
        await withDatabase(env, client => client.query("SELECT 1 AS ok"));
        return new Response(JSON.stringify({ ok: true, database: "connected" }), {
          status: 200,
          headers: JSON_HEADERS
        });
      } catch {
        return unavailable("backend");
      }
    }
    if (pathname === "/chat" || pathname === "/signal") {
      return unavailable("real-time connection");
    }

    if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return new Response("Static asset binding is not configured.", {
        status: 503,
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
      });
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    for (const [name, value] of Object.entries(JSON_HEADERS)) {
      if (name.toLowerCase() !== "content-type" && name.toLowerCase() !== "cache-control") headers.set(name, value);
    }
    return new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
  }
};
