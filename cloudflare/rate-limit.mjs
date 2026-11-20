let checks = 0;
export async function allowRequest(client, secret, key, max, windowMs) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("OTP rate-limit secret is not configured.");
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(String(key)));
  const keyHash = [...new Uint8Array(signature)].map(value => value.toString(16).padStart(2, "0")).join("");
  const result = await client.query("INSERT INTO api_rate_limits (key_hash, hit_count, expires_at) VALUES ($1, 1, NOW() + ($2::double precision * INTERVAL '1 millisecond')) ON CONFLICT (key_hash) DO UPDATE SET hit_count = CASE WHEN api_rate_limits.expires_at <= NOW() THEN 1 ELSE api_rate_limits.hit_count + 1 END, expires_at = CASE WHEN api_rate_limits.expires_at <= NOW() THEN NOW() + ($3::double precision * INTERVAL '1 millisecond') ELSE api_rate_limits.expires_at END RETURNING hit_count", [keyHash, windowMs]);
  checks += 1;
  if (checks % 100 === 0) {
    try { await client.query("DELETE FROM api_rate_limits WHERE key_hash IN (SELECT key_hash FROM api_rate_limits WHERE expires_at <= NOW() LIMIT 500)"); } catch {}
  }
  return Number(result.rows[0].hit_count) <= max;
}