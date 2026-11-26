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
    // Sets the key only if it doesn't exist yet; true when this call set it (a lock).
    setIfAbsent: async (key, value, ttlSeconds) => (await command("SET", PREFIX + key, value, "NX", "EX", String(ttlSeconds))) === "OK",
    // Writes only if the key still holds `expected`, so a background rewrite never undoes a newer save.
    replaceIf: (key, expected, value) => command("EVAL", "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('SET', KEYS[1], ARGV[2]) end return nil", "1", PREFIX + key, expected, value),
    addToSet: (key, member) => command("SADD", PREFIX + key, member),
    removeFromSet: (key, member) => command("SREM", PREFIX + key, member),
    members: async key => (await command("SMEMBERS", PREFIX + key)) || [],
    // A plain integer counter (API quota per day). Not sealed: it holds no user data, and
    // INCRBY has to operate on the stored value.
    increment: async (key, by = 1, ttlSeconds) => {
      const total = await command("INCRBY", PREFIX + key, String(by));
      if (ttlSeconds) await command("EXPIRE", PREFIX + key, String(ttlSeconds));
      return Number(total);
    }
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
    setIfAbsent: async (key, value, ttlSeconds) => { if (live(key) !== null) return false; values.set(key, value); expiry.set(key, Date.now() + ttlSeconds * 1000); return true; },
    replaceIf: async (key, expected, value) => { if (live(key) === expected) values.set(key, value); },
    addToSet: async (key, member) => { if (!sets.has(key)) sets.set(key, new Set()); sets.get(key).add(member); },
    removeFromSet: async (key, member) => { sets.get(key)?.delete(member); },
    members: async key => [...(sets.get(key) || [])],
    increment: async (key, by = 1, ttlSeconds) => {
      const total = Number(live(`ctr:${key}`) || 0) + Number(by);
      values.set(`ctr:${key}`, total);
      if (ttlSeconds) expiry.set(`ctr:${key}`, Date.now() + ttlSeconds * 1000);
      return total;
    }
  };
}

/**
 * Connections for one user, encrypted at rest. `seal`/`open` are the server's AES-256-GCM
 * helpers (encryptJson/decryptJson); each value is sealed with its own storage key as context, so
 * a value copied to another user's or provider's key no longer opens. `isCurrent` says whether a
 * sealed value already uses the current key and format; older ones are rewritten when read.
 * Returns null when no store is configured, so callers can say "not set up on this server".
 */
export function createConnectionStore({ seal, open, isCurrent = () => true, backend } = {}) {
  const kv = backend || (redisConfig() ? redisStore(redisConfig()) : process.env.CONNECTIONS_STORE === "memory" ? memoryStore() : null);
  if (!kv) return null;
  const key = (userId, provider) => `conn:${userId}:${provider}`;
  const profileKey = (userId, slug) => `profile:${userId}:${slug}`;
  // Reads a sealed record; a backend failure throws (so callers can tell "down" from "missing").
  async function read(storageKey) {
    const sealed = await kv.get(storageKey);
    if (!sealed) return null;
    let record;
    try { record = open(sealed, storageKey); } catch { return null; }
    // Sealed before key IDs or with a previous key: rewrite it bound to its key with the current key.
    if (!isCurrent(sealed) && kv.replaceIf) await kv.replaceIf(storageKey, sealed, seal(record, storageKey)).catch(() => {});
    return record;
  }
  // Profiles are read on every request to a profile connector, so each server instance keeps them
  // for 30 seconds; a save or delete on this instance applies at once.
  const PROFILE_CACHE_MS = 30_000;
  const profileCache = new Map();
  const cachedProfile = async (cacheKey, load) => {
    const hit = profileCache.get(cacheKey);
    if (hit && hit.at > Date.now() - PROFILE_CACHE_MS) return hit.value;
    const value = await load();
    profileCache.set(cacheKey, { value, at: Date.now() });
    return value;
  };
  const forgetProfiles = userId => { for (const cacheKey of profileCache.keys()) if (cacheKey.startsWith(`${userId}:`)) profileCache.delete(cacheKey); };
  return {
    durable: kv.durable,
    get: (userId, provider) => read(key(userId, provider)),
    async save(userId, provider, record) {
      const storageKey = key(userId, provider);
      await kv.set(storageKey, seal({ ...record, provider, updatedAt: Date.now() }, storageKey));
      await kv.addToSet(`conns:${userId}`, provider);
    },
    async remove(userId, provider) {
      await kv.del(key(userId, provider));
      await kv.removeFromSet(`conns:${userId}`, provider);
      // A Clarity project's daily snapshots go with it.
      if (String(provider).startsWith("clarity")) await this.removeSnapshots(userId, provider);
    },
    list: userId => kv.members(`conns:${userId}`),
    // About the user's main sign-in (its Google email), shown on the Connections page.
    getAccountInfo: userId => read(`account:${userId}`),
    async saveAccountInfo(userId, info) {
      const storageKey = `account:${userId}`;
      await kv.set(storageKey, seal({ ...info, updatedAt: Date.now() }, storageKey));
    },
    // Profiles: a named set of one account per platform plus default IDs, served at /mcp/p/<slug>.
    getProfile: (userId, slug) => cachedProfile(`${userId}:${slug}`, () => read(profileKey(userId, slug))),
    async listProfiles(userId) {
      const slugs = await cachedProfile(`${userId}:*`, () => kv.members(`profiles:${userId}`));
      const profiles = await Promise.all([...slugs].sort().map(slug => this.getProfile(userId, slug)));
      return profiles.filter(Boolean);
    },
    async saveProfile(userId, profile) {
      const storageKey = profileKey(userId, profile.slug);
      await kv.set(storageKey, seal({ ...profile, updatedAt: Date.now() }, storageKey));
      await kv.addToSet(`profiles:${userId}`, profile.slug);
      forgetProfiles(userId);
    },
    async removeProfile(userId, slug) {
      await kv.del(profileKey(userId, slug));
      await kv.removeFromSet(`profiles:${userId}`, slug);
      forgetProfiles(userId);
    },
    /**
     * Moves everything a user ID holds (connections, Clarity snapshots, profiles) to another user ID,
     * then deletes it from the first. Used once per account when connections became per assistant.
     * Entries the target already has are kept and the old copy is dropped. Returns how many moved.
     */
    async moveUser(from, to) {
      const existing = new Set(await this.list(to));
      const targets = new Set(await kv.members("clarity-snapshots"));
      let moved = 0;
      for (const id of await this.list(from)) {
        const record = await this.get(from, id);
        if (record && !existing.has(id)) {
          await this.save(to, id, record);
          if (String(id).startsWith("clarity")) {
            for (const date of await kv.members(`snaps:${from}:${id}`)) {
              const snapshot = await this.getSnapshot(from, id, date);
              if (snapshot) await this.saveSnapshot(to, id, date, snapshot);
            }
            if (targets.has(`${from}|${id}`)) await this.addSnapshotTarget(to, id);
          }
          moved++;
        }
        await this.remove(from, id);
      }
      for (const profile of await this.listProfiles(from)) {
        if (!(await this.getProfile(to, profile.slug))) { await this.saveProfile(to, profile); moved++; }
        await this.removeProfile(from, profile.slug);
      }
      return moved;
    },
    // Long-running tool calls (MCP tasks), sealed and bound to their user like every other record.
    getTask: (userId, taskId) => read(`task:${userId}:${taskId}`),
    async saveTask(userId, taskId, record, ttlSeconds) {
      const storageKey = `task:${userId}:${taskId}`;
      await kv.set(storageKey, seal(record, storageKey), { ttlSeconds });
    },
    lockTask: (userId, taskId, ttlSeconds) => kv.setIfAbsent(`tasklock:${userId}:${taskId}`, "1", ttlSeconds),
    unlockTask: (userId, taskId) => kv.del(`tasklock:${userId}:${taskId}`),
    // Daily Clarity snapshots: a set of "<user>|<connection>" the daily job visits, and one sealed
    // record per connection and day, kept 400 days.
    addSnapshotTarget: (userId, id) => kv.addToSet("clarity-snapshots", `${userId}|${id}`),
    removeSnapshotTarget: (userId, id) => kv.removeFromSet("clarity-snapshots", `${userId}|${id}`),
    async snapshotTargets() {
      return (await kv.members("clarity-snapshots")).map(member => {
        const at = String(member).lastIndexOf("|");
        return at > 0 ? { userId: member.slice(0, at), id: member.slice(at + 1) } : null;
      }).filter(Boolean);
    },
    getSnapshot: (userId, id, date) => read(`snap:${userId}:${id}:${date}`),
    async saveSnapshot(userId, id, date, data) {
      const storageKey = `snap:${userId}:${id}:${date}`;
      await kv.set(storageKey, seal({ ...data, date, savedAt: Date.now() }, storageKey), { ttlSeconds: 400 * 86_400 });
      await kv.addToSet(`snaps:${userId}:${id}`, date);
    },
    async removeSnapshots(userId, id) {
      for (const date of await kv.members(`snaps:${userId}:${id}`)) await kv.del(`snap:${userId}:${id}:${date}`);
      await kv.del(`snaps:${userId}:${id}`);
      await kv.removeFromSet("clarity-snapshots", `${userId}|${id}`);
    },
    // Drops a cached entry so the next `cached()` call rebuilds it (the Ads directory's
    // refresh: true option).
    async clearCached(cacheKey) {
      try { await kv.del(`cache:${cacheKey}`); return true; } catch { return false; }
    },
    // Counts API requests per day (Google Ads quota, item 20). Returns the running total,
    // or null when the backend cannot count, so quota tracking never fails a request.
    async incrementCounter(key, by = 1, ttlSeconds = 2 * 86_400) {
      if (typeof kv.increment !== "function") return null;
      try { return await kv.increment(key, by, ttlSeconds); } catch { return null; }
    },
    // Short-lived cache for rate-limited providers (Clarity allows 10 requests a day).
    async cached(cacheKey, ttlSeconds, load) {
      const storageKey = `cache:${cacheKey}`;
      const hit = await kv.get(storageKey);
      if (hit) { try { return { ...open(hit, storageKey), cached: true }; } catch { /* fall through and reload */ } }
      const fresh = await load();
      if (fresh?.ok) await kv.set(storageKey, seal(fresh, storageKey), { ttlSeconds });
      return fresh;
    }
  };
}
