import { withDatabase } from "./database.mjs";
import { handleAuthMe } from "./auth.mjs";
import { handleProfilePatch } from "./profile.mjs";
import { handleContactsGet } from "./contacts.mjs";
import { handleMessages } from "./messages.mjs";
import { handleUserLookup } from "./users.mjs";
import { handleCallsRead } from "./calls.mjs";
import { handleContactMutation } from "./contact-mutations.mjs";
import { handleModeration } from "./moderation.mjs";
import { handleOtpAndLogout } from "./otp.mjs";
import { handleAccountDelete } from "./account.mjs";
import { handleCallMutation } from "./call-mutations.mjs";
import { publishUserEvent } from "./user-events.mjs";
export { CallRooms } from "./call-rooms.mjs";
export { UserEvents } from "./user-events.mjs";

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

function cookieToken(request) {
  for (const part of String(request.headers.get("cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== "lovemet_session") continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ""; }
  }
  return "";
}
async function tokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

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

    // Explicit routes are handled by Fetch-native adapters and Durable Objects;
    // unknown API paths fail closed below until the full migration is complete.
    if (pathname === "/chat") {
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required.", { status: 426, headers: JSON_HEADERS });
      }
      if (!env.USER_EVENTS) return unavailable("real-time connection");
      const token = cookieToken(request);
      if (!token || token.length > 200) return new Response("Sign in required.", { status: 401, headers: JSON_HEADERS });
      const hash = await tokenHash(token);
      try {
        const session = await withDatabase(env, client => client.query(
          "SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() LIMIT 1",
          [hash]
        ));
        if (!session.rowCount) return new Response("Sign in required.", { status: 401, headers: JSON_HEADERS });
        return env.USER_EVENTS.get(env.USER_EVENTS.idFromName(session.rows[0].id)).fetch(request);
      } catch {
        return unavailable("real-time connection");
      }
    }
    if (pathname === "/signal") {
      const roomId = url.searchParams.get("roomId") || "";
      if (!/^[0-9a-f-]{36}$/i.test(roomId)) return new Response("A valid call invitation is required.", { status: 400 });
      if (!env.CALL_ROOMS) return unavailable("real-time connection");
      const id = env.CALL_ROOMS.idFromName(roomId);
      return env.CALL_ROOMS.get(id).fetch(request);
    }
    if (pathname === "/api/calls/invite" || pathname === "/api/calls/respond") {
      try {
        const response = await withDatabase(env, client => handleCallMutation(request, client, env));
        if (response.ok) {
          const payload = await response.clone().json().catch(() => null);
          const invite = payload?.invite;
          if (invite?.caller_id && invite?.callee_id) {
            await Promise.all([
              publishUserEvent(env, invite.caller_id, { type: "call-update" }),
              publishUserEvent(env, invite.callee_id, { type: "call-update" })
            ]);
          }
        }
        return response;
      } catch {
        return unavailable("API");
      }
    }
    if (pathname === "/api/account") {
      try {
        return await withDatabase(env, client => handleAccountDelete(request, client, env));
      } catch {
        return unavailable("API");
      }
    }
    if (pathname === "/api/auth/request-otp" || pathname === "/api/auth/verify-otp" || pathname === "/api/auth/logout") {
      try {
        return await withDatabase(env, client => handleOtpAndLogout(request, client, env));
      } catch {
        return unavailable("API");
      }
    }
    if (pathname === "/api/contacts/block" || pathname === "/api/contacts/unblock" || pathname === "/api/users/report") {
      try {
        return await withDatabase(env, client => handleModeration(request, client, env));
      } catch {
        return unavailable("API");
      }
    }
    if (pathname === "/api/contacts/request" || pathname === "/api/contacts/respond") {
      try {
        return await withDatabase(env, client => handleContactMutation(request, client, env));
      } catch {
        return unavailable("API");
      }
    }
    if (pathname === "/api/calls/config" || pathname === "/api/calls/history" || pathname === "/api/calls/status" || pathname === "/api/calls/invites") {
      try {
        return await withDatabase(env, client => handleCallsRead(request, client, env));
      } catch {
        return unavailable("API");
      }
    }
    if (pathname === "/api/users/search" || pathname === "/api/contacts/blocks") {
      try {
        return await withDatabase(env, client => handleUserLookup(request, client, env));
      } catch {
        return unavailable("API");
      }
    }
    if (pathname === "/api/messages") {
      try {
        return await withDatabase(env, client => handleMessages(request, client, env));
      } catch {
        return unavailable("API");
      }
    }
    if (pathname === "/api/contacts" || pathname === "/api/contacts/requests") {
      try {
        return await withDatabase(env, client => handleContactsGet(request, client));
      } catch {
        return unavailable("API");
      }
    }
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
      if (!env.USER_EVENTS || !env.CALL_ROOMS) return unavailable("backend");
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
