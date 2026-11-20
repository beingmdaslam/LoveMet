const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY"
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
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      return unavailable("API");
    }
    if (pathname === "/healthz") {
      return unavailable("backend");
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

    return env.ASSETS.fetch(request);
  }
};
