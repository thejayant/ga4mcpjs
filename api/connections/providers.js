// Platforms people connect on the Connections page. Each entry says how to connect (an API
// key form here; OAuth providers add `oauth`), how to check the credentials, and how to call
// the API. Responses are returned to the tools, never logged.

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

/* ---------------- Registry ---------------- */

export const PROVIDERS = {
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
export function publicConnection(provider, record) {
  const config = PROVIDERS[provider];
  if (!config || !record) return null;
  return { provider, name: config.name, summary: record.summary || null, label: record.credentials?.project || null, connectedAt: record.connectedAt || record.updatedAt || null };
}
