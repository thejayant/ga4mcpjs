// Durable, encrypted storage for per-user connections (and short-lived caches), so new
// platforms can be connected without widening the MCP token or reconnecting the app.
// Upstash Redis over its REST API (no extra package); Vercel's Upstash integration sets
// KV_REST_API_URL / KV_REST_API_TOKEN, a direct Upstash database UPSTASH_REDIS_REST_*.
// Values are encrypted with the server key before they leave the process.

const PREFIX = "mc:";

// Vercel's integration lets the owner pick a prefix (KV_, STORAGE_, …), so find any
// *_REST_API_URL / *_REST_API_TOKEN pair (the write token, not the read-only one).
export function redisConfig(env = process.env) {
  const pairs = [["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"], ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ...Object.keys(env).filter(key => key.endsWith("_REST_API_URL")).map(key => [key, key.replace(/_URL$/, "_TOKEN")])];
  for (const [urlKey, tokenKey] of pairs) {
    if (env[urlKey] && env[tokenKey]) return { url: env[urlKey].replace(/\/+$/, ""), token: env[tokenKey] };
  }
  return null;
}

function redisStore({ url, token }) {
  const command = async (...args) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10_000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(`Connection store error: ${body.error || response.status}`);
    return body.result;
  };
  return {
    durable: true,
    get: key => command("GET", PREFIX + key),
    set: (key, value, { ttlSeconds } = {}) => ttlSeconds ? command("SET", PREFIX + key, value, "EX", String(ttlSeconds)) : command("SET", PREFIX + key, value),
    del: key => command("DEL", PREFIX + key),
    addToSet: (key, member) => command("SADD", PREFIX + key, member),
    removeFromSet: (key, member) => command("SREM", PREFIX + key, member),
    members: async key => (await command("SMEMBERS", PREFIX + key)) || []
  };
}

// For tests and local development only: lost when the process restarts.
export function memoryStore() {
  const values = new Map(), sets = new Map(), expiry = new Map();
  const live = key => { if (expiry.has(key) && expiry.get(key) < Date.now()) { values.delete(key); expiry.delete(key); } return values.get(key) ?? null; };
  return {
    durable: false,
    get: async key => live(key),
    set: async (key, value, { ttlSeconds } = {}) => { values.set(key, value); if (ttlSeconds) expiry.set(key, Date.now() + ttlSeconds * 1000); else expiry.delete(key); },
    del: async key => { values.delete(key); expiry.delete(key); },
    addToSet: async (key, member) => { if (!sets.has(key)) sets.set(key, new Set()); sets.get(key).add(member); },
    removeFromSet: async (key, member) => { sets.get(key)?.delete(member); },
    members: async key => [...(sets.get(key) || [])]
  };
}

/**
 * Connections for one user, encrypted at rest. `seal`/`open` are the server's AES-256-GCM
 * helpers (encryptJson/decryptJson). Returns null when no store is configured, so callers
 * can say "not set up on this server" instead of failing.
 */
export function createConnectionStore({ seal, open, backend } = {}) {
  const kv = backend || (redisConfig() ? redisStore(redisConfig()) : process.env.CONNECTIONS_STORE === "memory" ? memoryStore() : null);
  if (!kv) return null;
  const key = (userId, provider) => `conn:${userId}:${provider}`;
  return {
    durable: kv.durable,
    async get(userId, provider) {
      const sealed = await kv.get(key(userId, provider));
      if (!sealed) return null;
      try { return open(sealed); } catch { return null; }
    },
    async save(userId, provider, record) {
      await kv.set(key(userId, provider), seal({ ...record, provider, updatedAt: Date.now() }));
      await kv.addToSet(`conns:${userId}`, provider);
    },
    async remove(userId, provider) {
      await kv.del(key(userId, provider));
      await kv.removeFromSet(`conns:${userId}`, provider);
    },
    list: userId => kv.members(`conns:${userId}`),
    // Short-lived cache for rate-limited providers (Clarity allows 10 requests a day).
    async cached(cacheKey, ttlSeconds, load) {
      const hit = await kv.get(`cache:${cacheKey}`);
      if (hit) { try { return { ...open(hit), cached: true }; } catch { /* fall through and reload */ } }
      const fresh = await load();
      if (fresh?.ok) await kv.set(`cache:${cacheKey}`, seal(fresh), { ttlSeconds });
      return fresh;
    }
  };
}
