// Platforms people connect on the Connections page. Each entry says how to connect (an API
// key form here; OAuth providers add `oauth`), how to check the credentials, and how to call
// the API. Responses are returned to the tools, never logged.
import { createHash, createHmac } from "node:crypto";

const TIMEOUT_MS = 30_000;

async function getJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { ok: response.ok, status: response.status, body };
}

/* ---------------- Bing Webmaster Tools ---------------- */

const BING_BASE = "https://ssl.bing.com/webmaster/api.svc/json";

// Bing returns WCF dates like "/Date(1727852400000-0700)/"; turn them into YYYY-MM-DD.
export function bingDate(value) {
  const match = /\/Date\((-?\d+)/.exec(String(value || ""));
  return match ? new Date(Number(match[1])).toISOString().slice(0, 10) : value;
}
const cleanBing = value => Array.isArray(value)
  ? value.map(cleanBing)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "__type").map(([key, v]) => [key, typeof v === "string" && v.startsWith("/Date(") ? bingDate(v) : cleanBing(v)]))
    : value;

export async function bingCall(apiKey, method, params = {}) {
  const url = new URL(`${BING_BASE}/${method}`);
  url.searchParams.set("apikey", apiKey);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  const result = await getJson(url.toString(), { headers: { Accept: "application/json" } });
  return result.ok ? { ...result, body: cleanBing(result.body?.d ?? result.body) } : result;
}

/* ---------------- Microsoft Clarity ---------------- */

export const CLARITY_DIMENSIONS = ["Browser", "Device", "Country/Region", "OS", "Source", "Medium", "Campaign", "Channel", "URL"];

export async function clarityInsights(token, { numOfDays = 3, dimensions = [] } = {}) {
  const url = new URL("https://www.clarity.ms/export-data/api/v1/project-live-insights");
  url.searchParams.set("numOfDays", String(numOfDays));
  dimensions.slice(0, 3).forEach((dimension, i) => url.searchParams.set(`dimension${i + 1}`, dimension));
  return getJson(url.toString(), { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
}

/* ---------------- YouTube ---------------- */

// YouTube Analytics answers in columnHeaders + rows; turn each row into an object.
export function youtubeRows(body) {
  const headers = (body?.columnHeaders || []).map(header => header.name);
  return (body?.rows || []).map(row => Object.fromEntries(headers.map((name, i) => [name, row[i]])));
}

export async function youtubeData(accessToken, path, params = {}) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  return getJson(url.toString(), { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
}

export async function youtubeAnalytics(accessToken, params) {
  const url = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
  for (const [key, value] of Object.entries({ ids: "channel==MINE", ...params })) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  const result = await getJson(url.toString(), { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  return result.ok ? { ...result, body: { rows: youtubeRows(result.body) } } : result;
}

/* ---------------- Registry ---------------- */

export const PROVIDERS = {
  youtube: {
    name: "YouTube",
    category: "Video",
    help: "Sign in with the Google account that owns or manages the channel. If it manages several channels or Brand Accounts, Google asks which one to share. Access is read-only.",
    helpUrl: "https://studio.youtube.com/",
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"],
      clientId: () => process.env.GOOGLE_CLIENT_ID,
      clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
      // offline + consent so Google returns a refresh token; select_account to pick the channel's account.
      authParams: { access_type: "offline", prompt: "consent select_account" },
      buttonLabel: "Connect with Google"
    },
    // Names the channel that was shared, for the Connections page and tools.
    async describe(accessToken) {
      const result = await youtubeData(accessToken, "channels", { part: "snippet,statistics", mine: "true" });
      const channel = result.ok ? result.body?.items?.[0] : null;
      if (!channel) return { ok: false, message: result.ok ? "This Google account has no YouTube channel. Choose the account (or Brand Account) that owns the channel." : "YouTube could not be reached. Try again." };
      const subscribers = Number(channel.statistics?.subscriberCount || 0);
      return { ok: true, label: channel.snippet?.title, summary: `${subscribers.toLocaleString("en-US")} subscribers`, meta: { channelId: channel.id, title: channel.snippet?.title } };
    }
  },
  bing_webmaster: {
    name: "Bing Webmaster Tools",
    category: "SEO",
    fields: [{ key: "apiKey", label: "API key", secret: true, placeholder: "32-character key" }],
    help: "In Bing Webmaster Tools, open Settings (top right) → API Access → API Key → Generate API Key. One key covers all your verified sites.",
    helpUrl: "https://www.bing.com/webmasters",
    // A free call that proves the key works and shows which sites it covers.
    async verify({ apiKey }) {
      const result = await bingCall(apiKey, "GetUserSites");
      if (!result.ok) return { ok: false, message: result.status === 401 || result.status === 403 ? "Bing rejected this API key." : `Bing returned ${result.status}.` };
      const sites = (result.body || []).filter(site => site.IsVerified !== false).map(site => site.Url);
      return { ok: true, summary: sites.length ? `${sites.length} verified site${sites.length === 1 ? "" : "s"}` : "No verified sites yet", meta: { sites: sites.slice(0, 50) } };
    }
  },
  clarity: {
    name: "Microsoft Clarity",
    category: "Behaviour analytics",
    fields: [
      { key: "token", label: "Data Export API token", secret: true, placeholder: "eyJ…" },
      { key: "project", label: "Project name (for your reference)", placeholder: "getcarports.com", optional: true }
    ],
    help: "In Clarity, open your project → Settings → Data Export → Generate new API token (project admins only). Clarity allows 10 requests a day per project, so the key is checked on first use rather than now.",
    helpUrl: "https://clarity.microsoft.com/",
    // Only a shape check: a live check would spend one of the project's 10 daily requests.
    async verify({ token }) {
      return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(token || "").trim())
        ? { ok: true, summary: "Token saved; checked on first use" }
        : { ok: false, message: "That doesn't look like a Clarity API token (it should have three parts separated by dots)." };
    }
  }
};

// What the Connections page and tools may show: never secrets.
// Stored ids are the provider ("youtube") or, for providers with several accounts, "provider:instance".
export const baseProvider = id => String(id).split(":")[0];

export function publicConnection(id, record) {
  const provider = baseProvider(id), config = PROVIDERS[provider];
  if (!config || !record) return null;
  return { id, provider, name: config.name, summary: record.summary || null, label: record.label || record.credentials?.project || null, connectedAt: record.connectedAt || record.updatedAt || null,
    // Sign-ins without a refresh token (Meta) stop working when their token expires.
    expired: Boolean(record.oauth && !record.oauth.refreshToken && record.oauth.expiresAt && record.oauth.expiresAt < Date.now()) };
}

/* ---------------- Extra accounts (Google, Meta, CallRail) ---------------- */

// The main sign-in holds one Google, one Meta and one CallRail connection. These let a user add
// any number more; tools route each request to the account that can see the requested property
// (api/connections/routing.js). `multi` providers store one record per account.


const shortHash = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
const platform = { googleScopes: [], metaScopes: [], metaVersion: "v21.0", metaConfigId: null, callrailBase: "https://api.callrail.com/v3" };

// Called once by the server with its own scope lists and Meta/CallRail settings.
export function configureAccountProviders(settings) {
  Object.assign(platform, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined && value !== null)));
}

const metaProof = token => createHmac("sha256", process.env.META_APP_SECRET || "").update(token).digest("hex");
const metaGraph = (path, params) => {
  const url = new URL(`https://graph.facebook.com/${platform.metaVersion}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return getJson(url.toString());
};

Object.assign(PROVIDERS, {
  google_account: {
    name: "Google account",
    category: "Google",
    multi: true,
    help: "Add another Google account whose GA4 properties, Search Console sites, Google Ads accounts, Merchant Center accounts or Business Profile locations you manage. Your assistant then uses whichever account can see the property you ask about.",
    helpUrl: "https://myaccount.google.com/",
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      // The same Google permissions as the main sign-in, plus email to label the account.
      scopes: () => [...new Set([...platform.googleScopes, "openid", "email"])],
      clientId: () => process.env.GOOGLE_CLIENT_ID,
      clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
      authParams: { access_type: "offline", prompt: "consent select_account" },
      buttonLabel: "Add a Google account"
    },
    async describe(accessToken) {
      const me = await getJson("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!me.ok || !me.body?.sub) return { ok: false, message: "Google didn't confirm which account this is. Try again." };
      return { ok: true, instance: shortHash(`google:${me.body.sub}`), label: me.body.email || "Google account", summary: "Analytics, Search Console, Ads, Merchant Center" };
    }
  },

  meta_account: {
    name: "Meta account",
    category: "Meta",
    multi: true,
    help: "Add another Facebook login whose ad accounts, Pages or Instagram accounts you manage. Meta logins last about 60 days; connect again when one expires.",
    helpUrl: "https://business.facebook.com/",
    oauth: {
      clientId: () => process.env.META_APP_ID,
      clientSecret: () => process.env.META_APP_SECRET,
      scopes: () => platform.metaScopes,
      buttonLabel: "Add a Meta account",
      authorize({ redirectUri, state }) {
        const url = new URL(`https://www.facebook.com/${platform.metaVersion}/dialog/oauth`);
        const params = { client_id: process.env.META_APP_ID, redirect_uri: redirectUri, state, response_type: "code",
          ...(platform.metaConfigId ? { config_id: platform.metaConfigId, override_default_response_type: "true" } : { scope: platform.metaScopes.join(",") }) };
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return url.toString();
      },
      // Meta has no refresh tokens: swap the code for a short-lived token, then for a ~60-day one.
      async exchange(code, redirectUri) {
        const app = { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET };
        const short = await metaGraph("/oauth/access_token", { ...app, redirect_uri: redirectUri, code });
        if (!short.ok || !short.body?.access_token) throw new Error(short.body?.error?.message || "Meta did not return a token");
        const long = await metaGraph("/oauth/access_token", { ...app, grant_type: "fb_exchange_token", fb_exchange_token: short.body.access_token });
        const token = long.ok && long.body?.access_token ? long.body : short.body;
        return { accessToken: token.access_token, refreshToken: null, expiresAt: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : Date.now() + 60 * 86_400_000, scope: platform.metaScopes.join(",") };
      }
    },
    async describe(accessToken) {
      const me = await metaGraph("/me", { fields: "id,name", access_token: accessToken, appsecret_proof: metaProof(accessToken) });
      if (!me.ok || !me.body?.id) return { ok: false, message: me.body?.error?.message || "Meta didn't confirm which account this is." };
      return { ok: true, instance: shortHash(`meta:${me.body.id}`), label: me.body.name || "Meta account", summary: "Ad accounts, Pages, Instagram" };
    }
  },

  callrail_key: {
    name: "CallRail key",
    category: "CallRail",
    multi: true,
    fields: [
      { key: "apiToken", label: "CallRail API key", secret: true, placeholder: "API v3 key" },
      { key: "label", label: "Name (for your reference)", placeholder: "Agency CallRail", optional: true }
    ],
    help: "Add another CallRail login's API key (CallRail → your profile → API Keys). Each key's accounts and companies become available.",
    helpUrl: "https://app.callrail.com/",
    instance: credentials => shortHash(`callrail:${credentials.apiToken}`),
    async verify({ apiToken, label }) {
      const result = await getJson(`${platform.callrailBase}/a.json?per_page=250`, { headers: { Authorization: `Token token="${apiToken}"`, Accept: "application/json" } });
      if (!result.ok) return { ok: false, message: result.status === 401 ? "CallRail rejected this API key." : `CallRail returned ${result.status}.` };
      const accounts = (result.body?.accounts || []).map(account => ({ id: account.id, name: (account.name || account.id).trim() }));
      return { ok: true, label: label || accounts[0]?.name || "CallRail", summary: `${accounts.length} account${accounts.length === 1 ? "" : "s"}${accounts.length ? `: ${accounts.slice(0, 3).map(a => a.name).join(", ")}${accounts.length > 3 ? "…" : ""}` : ""}`, meta: { accounts } };
    }
  }
});
