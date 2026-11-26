// The single Google Ads request path. Every Ads call in this server goes through
// `adsRequest`, so the read-only gate, the login-customer-id rule, the retry ladder and
// quota accounting apply uniformly -- keyword planner and reach planner included.

import { assertReadOnly, readOnlyFlagState } from "./gate.js";
import { googleAdsApiUrl, googleAdsApiVersion } from "./version.js";
import { isCustomerNotEnabled, isPermissionDenied, normalizeAdsError, redactSecrets } from "./errors.js";

export function normalizeCustomerId(customerId) {
  return String(customerId ?? "").replace(/\D/g, "").trim();
}

/**
 * The login-customer-id rule (item 1), in ONE place.
 *
 * Order, strictly:
 *   1. an explicit loginCustomerId the caller passed
 *   2. the known manager for this customer, from the account directory
 *   3. the customerId itself
 *
 * There is deliberately no fallback to a global/env manager ID: sending a manager the
 * account is not linked under is what produced USER_PERMISSION_DENIED on accounts the
 * user could actually read.
 *
 * @param {{customerId?:string, loginCustomerId?:string, directoryEntry?:{loginCustomerId?:string}}} input
 */
export function resolveLoginCustomerId({ customerId, loginCustomerId, directoryEntry } = {}) {
  const explicit = normalizeCustomerId(loginCustomerId);
  if (explicit) return { loginCustomerId: explicit, source: "explicit" };

  const fromDirectory = normalizeCustomerId(directoryEntry?.loginCustomerId);
  if (fromDirectory) return { loginCustomerId: fromDirectory, source: "directory" };

  const self = normalizeCustomerId(customerId);
  if (self) return { loginCustomerId: self, source: "self" };

  return { loginCustomerId: undefined, source: "none" };
}

/**
 * Request headers. The developer token is optional since Google's 2026-09-09 sunset: it is
 * ignored by the API servers and access level now belongs to the Cloud project that issued
 * the OAuth credentials (item 25). It is sent only if the env still provides one.
 */
export function buildAdsHeaders({ accessToken, loginCustomerId, hasBody }) {
  const developerToken = String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim();
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(developerToken ? { "developer-token": developerToken } : {}),
    ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
    ...(hasBody ? { "Content-Type": "application/json" } : {})
  };
}

/**
 * Strips pageSize/page_size from a GoogleAdsService search body (item 2).
 *
 * v26 `search` rejects pageSize with PAGE_SIZE_NOT_SUPPORTED; pages are a fixed 10,000 rows.
 * Keyword Planner's generateKeywordIdeas DOES still accept page_size, so this is applied
 * only to the search/searchStream paths.
 */
export function stripSearchPageSize(path, body) {
  if (!body || typeof body !== "object") return body;
  if (!/googleAds:(search|searchStream)$/.test(String(path))) return body;
  const { pageSize, page_size: snakePageSize, ...rest } = body;
  return rest;
}

/** Per-day Ads request counter, keyed by Cloud project rather than token (items 20, 25). */
export function quotaProjectKey() {
  // The Cloud project that issued the OAuth client is what Google now meters. The client ID
  // identifies it; only its project-number prefix is used, so no secret is stored.
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const projectNumber = /^(\d+)-/.exec(clientId)?.[1];
  return projectNumber || (clientId ? "oauth-client" : "unknown-project");
}

export const QUOTA_LIMITS = Object.freeze({
  // Daily operation limits are per Cloud project since the developer token sunset.
  test: 15000, explorer: 2880, basic: 15000, standard: null // null = unlimited
});

export function quotaLimit() {
  const level = String(process.env.GOOGLE_ADS_ACCESS_LEVEL || "explorer").trim().toLowerCase();
  return { level, limit: Object.prototype.hasOwnProperty.call(QUOTA_LIMITS, level) ? QUOTA_LIMITS[level] : QUOTA_LIMITS.explorer };
}

/**
 * Counts one Ads request against today's quota and returns { usedToday, limit, level, warning }.
 * `store` is the project's connection store (KV-backed); with no store the count is skipped
 * and only the limit is reported, so quota tracking never blocks a call.
 */
export async function countAdsRequest(store, requests = 1) {
  const { level, limit } = quotaLimit();
  const day = new Date().toISOString().slice(0, 10);
  const key = `adsquota:${quotaProjectKey()}:${day}`;
  let usedToday = null;
  if (store?.incrementCounter) {
    try {
      usedToday = await store.incrementCounter(key, requests, 2 * 86_400);
    } catch {
      usedToday = null;
    }
  }
  const quota = { project: quotaProjectKey(), accessLevel: level, usedToday, limit };
  if (limit && usedToday !== null && usedToday >= limit * 0.8) {
    quota.warning = usedToday >= limit
      ? `Daily Google Ads quota for this Cloud project is used up (${usedToday}/${limit}).`
      : `Over 80% of today's Google Ads quota for this Cloud project is used (${usedToday}/${limit}).`;
  }
  return quota;
}

/**
 * One Google Ads HTTP request, gated.
 *
 * @param {object} options
 * @param {string} options.path      REST path or absolute URL
 * @param {string} options.accessToken
 * @param {string} [options.method]  defaults to POST
 * @param {object} [options.body]
 * @param {string} [options.loginCustomerId] already resolved by resolveLoginCustomerId
 * @param {Function} [options.fetchImpl] injectable for tests
 */
export async function adsFetch({ path, accessToken, method = "POST", body, loginCustomerId, fetchImpl } = {}) {
  const cleanBody = stripSearchPageSize(path, body);
  // The gate runs first: a refused request throws here, before any socket is opened.
  const allowed = assertReadOnly({ path, method, body: cleanBody });

  const doFetch = fetchImpl || globalThis.fetch;
  const url = googleAdsApiUrl(path);
  const response = await doFetch(url, {
    method,
    headers: buildAdsHeaders({ accessToken, loginCustomerId, hasBody: cleanBody !== undefined }),
    ...(cleanBody === undefined ? {} : { body: JSON.stringify(cleanBody) })
  });

  const rawText = await response.text();
  let parsed = rawText;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch { /* non-JSON body stays a string */ }

  // Logged without credentials (item 23) and with the API version (item 21).
  console.log(JSON.stringify(redactSecrets({
    type: "google_ads_api_debug",
    apiVersion: googleAdsApiVersion(),
    rpc: `${allowed.service}.${allowed.method}`,
    loginCustomerId: loginCustomerId ? `***${String(loginCustomerId).slice(-4)}` : null,
    status: response.status
  })));

  return { ok: response.ok, status: response.status, body: parsed, rpc: `${allowed.service}.${allowed.method}` };
}

/**
 * The retry ladder (item 3).
 *
 * On USER_PERMISSION_DENIED: retry once with login-customer-id = customerId, then once per
 * known manager of that customer on the same Google account. Every attempt is recorded and
 * returned so the caller can see exactly what was tried.
 *
 * On CUSTOMER_NOT_ENABLED: no retry at all -- the account is deactivated in every state, so
 * retrying only burns quota.
 *
 * @param {object} options
 * @param {string[]} [options.managerIds] managers to walk, most likely first
 */
export async function adsRequest({
  path, accessToken, method = "POST", body, customerId,
  loginCustomerId, directoryEntry, managerIds = [], fetchImpl, store, debug = false
} = {}) {
  const attempts = [];
  const first = resolveLoginCustomerId({ customerId, loginCustomerId, directoryEntry });

  // The header values to try, in order, de-duplicated.
  const ladder = [first.loginCustomerId];
  const self = normalizeCustomerId(customerId);
  if (self) ladder.push(self);
  for (const manager of managerIds) {
    const normalized = normalizeCustomerId(manager);
    if (normalized) ladder.push(normalized);
  }
  const tried = new Set();

  let response = null;
  for (const [index, candidate] of ladder.entries()) {
    const header = candidate || undefined;
    const key = header || "(none)";
    if (tried.has(key)) continue;
    tried.add(key);

    response = await adsFetch({ path, accessToken, method, body, loginCustomerId: header, fetchImpl });
    attempts.push({
      loginCustomerId: header || null,
      source: index === 0 ? first.source : header === self ? "self" : "manager-walk",
      status: response.status,
      ok: response.ok
    });

    if (response.ok) break;
    // Deactivated accounts are terminal: stop, and say so plainly.
    if (isCustomerNotEnabled(response)) break;
    // Anything that is not a permission problem will not be fixed by another header.
    if (!isPermissionDenied(response)) break;
  }

  const quota = await countAdsRequest(store, attempts.length);
  if (response?.ok) return { ...response, attempts, quota };
  return { ...response, attempts, quota, error: normalizeAdsError(response, { debug, attempts }) };
}

export function readOnlyNotice() {
  const flag = readOnlyFlagState();
  return {
    googleAds: "read-only",
    enforced: flag.enforced,
    ...(flag.ignoredOverride ? { note: "GOOGLE_ADS_READ_ONLY was set to something other than true; it was ignored and read-only enforcement stays on." } : {})
  };
}
