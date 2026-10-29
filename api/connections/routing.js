// Picks which connected account answers a request when a user has several logins for the same
// platform (extra Google accounts, Meta accounts or CallRail keys added on the Connections page).
//
// Each account's reachable resources (GA4 properties, Search Console sites, Ads customers, Merchant
// accounts, Business Profile accounts, Meta ad accounts and pages, CallRail accounts) are listed
// once and cached for an hour; a request goes to the account that can see the IDs in its
// arguments. An explicit `account` argument wins. With no extra accounts nothing is listed and the
// main sign-in is used, exactly as before.

export const FAMILIES = { google: "google_account", meta: "meta_account", callrail: "callrail_key" };
export const MAIN = "main";
const INDEX_TTL_SECONDS = 3600;

const digits = value => String(value ?? "").replace(/\D/g, "");
export const siteKey = value => String(value || "").trim().toLowerCase().replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

// The resource keys a request refers to, from its arguments ("ga4:123", "gsc:example.com", …).
export function resourceKeys(family, args = {}) {
  const keys = new Set();
  const add = (prefix, value) => { if (value) keys.add(`${prefix}:${value}`); };
  if (family === "google") {
    add("ga4", digits(args.propertyId || args.property));
    if (args.siteUrl) add("gsc", siteKey(args.siteUrl));
    for (const field of ["customerId", "managerCustomerId", "loginCustomerId"]) add("ads", digits(args[field]));
    add("merchant", digits(args.merchantAccountId));
    // accountId means a Merchant Center account in Merchant tools and a Business Profile account in GBP tools.
    if (args.accountId && /^(accounts\/)?\d+$/.test(String(args.accountId))) { add("merchant", digits(args.accountId)); add("gbp", digits(args.accountId)); }
    const location = /^accounts\/(\d+)\/locations\//.exec(String(args.gbpLocation || args.location || args.name || ""));
    if (location) add("gbp", location[1]);
  }
  if (family === "meta") {
    for (const field of ["adAccountId", "accountId"]) add("ad", digits(args[field]));
    add("page", digits(args.pageId));
  }
  if (family === "callrail") {
    for (const field of ["accountId", "callrailAccountId"]) if (args[field]) add("cr", String(args[field]).split(":")[0]);
  }
  return [...keys];
}

/**
 * store: the connection store; listers: { google(creds), meta(creds), callrail(apiToken) } →
 * resource keys the credentials can reach; credentialsFor: (family, record, id, userId) →
 * credentials for an extra account (refreshing OAuth tokens as needed).
 */
export function createAccountRouter({ store, listers, credentialsFor, labels }) {
  async function extras(userId, family) {
    if (!store || !userId) return [];
    const prefix = `${FAMILIES[family]}:`;
    const ids = (await store.list(userId)).filter(id => id.startsWith(prefix));
    const records = await Promise.all(ids.map(async id => ({ id, record: await store.get(userId, id) })));
    return records.filter(entry => entry.record);
  }

  async function reachable(userId, family, accountKey, getCredentials) {
    const cacheKey = `idx:${userId}:${family}:${accountKey}`;
    const result = await store.cached(cacheKey, INDEX_TTL_SECONDS, async () => {
      try {
        const keys = await listers[family](await getCredentials());
        return { ok: true, keys };
      } catch {
        return { ok: false, keys: [] };
      }
    });
    return new Set(result.keys || []);
  }

  // The accounts a user has for a family: the main sign-in (when it has this platform) plus extras.
  async function accounts(userId, family, primary) {
    const list = primary ? [{ key: MAIN, label: labels.main(family), credentials: async () => primary }] : [];
    for (const { id, record } of await extras(userId, family)) {
      list.push({ key: id, label: record.label || record.summary || id, credentials: () => credentialsFor(family, record, id, userId) });
    }
    return list;
  }

  /**
   * Returns { key, label, credentials } for the account that should serve this request, or null to
   * keep the main sign-in's own handling (including its usual "not connected" errors).
   */
  async function choose({ userId, family, args = {}, account, primary }) {
    if (!store || !userId) return null;
    const options = await accounts(userId, family, primary);
    if (!options.length || (options.length === 1 && options[0].key === MAIN)) return null;
    if (account) {
      const wanted = String(account).toLowerCase();
      const match = options.find(option => option.key.toLowerCase() === wanted || String(option.label).toLowerCase() === wanted);
      if (!match) throw new Error(`No connected ${family} account called "${account}". Connected: ${options.map(o => `${o.label} (${o.key})`).join(", ")}.`);
      return use(match);
    }
    const wanted = resourceKeys(family, args);
    if (wanted.length) {
      for (const option of options) {
        const keys = await reachable(userId, family, option.key, option.credentials);
        if (wanted.some(key => keys.has(key))) return use(option);
      }
    }
    // Nothing to match on (a list tool) or no account can see it: main sign-in, else the first extra.
    return use(options[0]);
  }

  // The main sign-in is returned as null so its own handling (refresh, errors) stays unchanged.
  const use = async option => option.key === MAIN ? null : { ...option, credentials: await option.credentials() };

  return { accounts, choose };
}
