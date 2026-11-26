// The Google Ads account directory (item 5).
//
// Built once per user and cached for ~12h, this is what lets every Ads tool auto-route on
// customerId alone: it records, for each reachable customer, which connected Google account
// can see it and which login-customer-id header actually works.
//
// Building it costs more than one API request, which is a deliberate exception to the
// "one tool call = one API request" rule -- hence the cache and the explicit refresh flag.

import { adsRequest, normalizeCustomerId } from "./client.js";
import { isCustomerNotEnabled, isPermissionDenied } from "./errors.js";
import { withGaqlLimit } from "./gaql.js";

export const DIRECTORY_TTL_SECONDS = 12 * 60 * 60;

const CUSTOMER_QUERY =
  "SELECT customer.id, customer.descriptive_name, customer.manager, customer.status, " +
  "customer.currency_code, customer.time_zone, customer.test_account FROM customer";

const CLIENT_QUERY =
  "SELECT customer_client.id, customer_client.client_customer, customer_client.descriptive_name, " +
  "customer_client.manager, customer_client.status, customer_client.currency_code, " +
  "customer_client.time_zone, customer_client.level, customer_client.test_account FROM customer_client";

// The Ads REST API answers in lowerCamelCase; GAQL paths are snake_case. Read either.
function pick(source, path) {
  return String(path).split(".").filter(Boolean).reduce((current, segment) => {
    if (current === undefined || current === null) return undefined;
    if (current[segment] !== undefined) return current[segment];
    return current[segment.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase())];
  }, source);
}

/** Resource names from listAccessibleCustomers -> bare customer IDs. */
export function accessibleCustomerIds(body) {
  return (body?.resourceNames || body?.resource_names || [])
    .map((name) => normalizeCustomerId(String(name).split("/").pop()))
    .filter(Boolean);
}

function entryFromCustomerRow(row, { googleAccount, loginCustomerId }) {
  const status = pick(row, "customer.status") || null;
  const isManager = pick(row, "customer.manager") === true;
  return {
    customerId: normalizeCustomerId(pick(row, "customer.id")),
    name: pick(row, "customer.descriptive_name") || null,
    isManager,
    status,
    currency: pick(row, "customer.currency_code") || null,
    timeZone: pick(row, "customer.time_zone") || null,
    isTestAccount: pick(row, "customer.test_account") === true,
    googleAccount,
    loginCustomerId: normalizeCustomerId(loginCustomerId) || null,
    ...assessStatus(status),
    lastChecked: new Date().toISOString()
  };
}

function entryFromClientRow(row, { googleAccount, loginCustomerId }) {
  const status = pick(row, "customer_client.status") || null;
  return {
    customerId: normalizeCustomerId(pick(row, "customer_client.id")),
    name: pick(row, "customer_client.descriptive_name") || null,
    isManager: pick(row, "customer_client.manager") === true,
    status,
    currency: pick(row, "customer_client.currency_code") || null,
    timeZone: pick(row, "customer_client.time_zone") || null,
    isTestAccount: pick(row, "customer_client.test_account") === true,
    level: Number(pick(row, "customer_client.level") ?? 0) || 0,
    googleAccount,
    // A client account is reached through the manager we walked it from.
    loginCustomerId: normalizeCustomerId(loginCustomerId) || null,
    managerCustomerId: normalizeCustomerId(loginCustomerId) || null,
    ...assessStatus(status),
    lastChecked: new Date().toISOString()
  };
}

// Statuses Google uses for an account that genuinely cannot serve data.
const DEAD_STATUSES = new Set(["CANCELED", "SUSPENDED", "CLOSED", "NOT_ENABLED"]);

/**
 * Whether an account is worth querying, from its customer.status.
 *
 * Only a status Google defines as terminal marks an account unusable. UNKNOWN,
 * UNSPECIFIED and a missing status mean Google did not populate the field for this
 * caller -- which is not evidence the account is dead. Those stay usable, with a caveat,
 * because wrongly hiding a working account is worse than letting a query fail with a
 * clear error.
 */
export function assessStatus(status) {
  if (status === "ENABLED") return { usable: true, usableReason: null };
  if (DEAD_STATUSES.has(status)) return { usable: false, usableReason: describeUnusable(status) };
  return {
    usable: true,
    usableReason: null,
    statusNote: status
      ? `Google reported this account's status as ${status} rather than ENABLED. That usually means the status was not populated for this login, not that the account is inactive. It is still queried; if it is in fact inactive, the query returns a clear error.`
      : "Google did not report a status for this account. It is still queried; if it is inactive, the query returns a clear error."
  };
}

function describeUnusable(status) {
  if (status === "CANCELED") return "The account is cancelled.";
  if (status === "SUSPENDED") return "The account is suspended.";
  if (status === "CLOSED") return "The account is closed.";
  if (status === "NOT_ENABLED") return "The account is deactivated (cancelled, suspended, or setup never finished).";
  return `The account status is ${status}, so it cannot serve reporting data.`;
}

/**
 * Builds the directory for one connected Google account.
 *
 * @param {object} options
 * @param {string} options.accessToken
 * @param {string} options.googleAccount  the connection label/key this token belongs to
 */
export async function buildAccountDirectoryForAccount({ accessToken, googleAccount, fetchImpl, store, debug }) {
  const entries = new Map();
  const notes = [];
  let requestCount = 0;

  const accessible = await adsRequest({
    path: "customers:listAccessibleCustomers",
    method: "GET",
    accessToken, fetchImpl, store, debug
  });
  requestCount += accessible.attempts?.length || 1;

  if (!accessible.ok) {
    return { googleAccount, entries: [], requestCount, error: accessible.error, notes };
  }

  const ids = accessibleCustomerIds(accessible.body);
  if (!ids.length) {
    // The directmetalstructures@gmail.com case: listAccessibleCustomers returns {} (item 6).
    notes.push(`${googleAccount} has no Google Ads accounts: listAccessibleCustomers returned an empty list. This Google login is not a user on any Ads account.`);
    return { googleAccount, entries: [], requestCount, notes, empty: true };
  }

  for (const customerId of ids) {
    // Per the header rule, a top-level accessible customer is queried under itself.
    const response = await adsRequest({
      path: `customers/${customerId}/googleAds:search`,
      accessToken, customerId, body: { query: CUSTOMER_QUERY },
      fetchImpl, store, debug
    });
    requestCount += response.attempts?.length || 1;

    if (!response.ok) {
      entries.set(customerId, {
        customerId, name: null, isManager: false,
        status: isCustomerNotEnabled(response) ? "NOT_ENABLED" : null,
        googleAccount,
        loginCustomerId: customerId,
        usable: false,
        usableReason: isCustomerNotEnabled(response)
          ? "The account is deactivated (cancelled, suspended, or setup never finished)."
          : isPermissionDenied(response)
            ? "The connected Google user could not read this account even with every known header."
            : response.error?.message || "Google could not describe this account.",
        errorCode: response.error?.code || null,
        lastChecked: new Date().toISOString()
      });
      continue;
    }

    for (const row of response.body?.results || []) {
      const entry = entryFromCustomerRow(row, { googleAccount, loginCustomerId: customerId });
      if (entry.customerId) entries.set(entry.customerId, entry);
    }
  }

  // Expand every manager into its enabled clients, with levels (item 5).
  for (const manager of [...entries.values()].filter((entry) => entry.isManager && entry.usable)) {
    const response = await adsRequest({
      path: `customers/${manager.customerId}/googleAds:search`,
      accessToken,
      customerId: manager.customerId,
      loginCustomerId: manager.customerId,
      body: { query: withGaqlLimit(`${CLIENT_QUERY} WHERE customer_client.status = 'ENABLED' ORDER BY customer_client.level ASC`, 5000) },
      fetchImpl, store, debug
    });
    requestCount += response.attempts?.length || 1;
    if (!response.ok) {
      notes.push(`Could not expand manager ${manager.customerId}: ${response.error?.code || "unknown error"}.`);
      continue;
    }
    for (const row of response.body?.results || []) {
      const entry = entryFromClientRow(row, { googleAccount, loginCustomerId: manager.customerId });
      // level 0 is the manager itself; keep the richer top-level record for it.
      if (!entry.customerId || entry.customerId === manager.customerId) continue;
      const existing = entries.get(entry.customerId);
      // A directly-accessible record wins, but inherit the working manager header from here.
      if (existing && !existing.managerCustomerId) {
        entries.set(entry.customerId, { ...existing, managerCustomerId: manager.customerId });
        continue;
      }
      if (!existing) entries.set(entry.customerId, entry);
    }
  }

  return { googleAccount, entries: [...entries.values()], requestCount, notes };
}

/**
 * The directory across every connected Google account, cached per user with a TTL (item 5).
 *
 * @param {object} options
 * @param {Array<{label:string, accessToken:string}>} options.accounts
 * @param {object} [options.store] connection store, for the cache
 * @param {boolean} [options.refresh] bypass the cache
 */
export async function getAccountDirectory({ userId, accounts, store, refresh = false, fetchImpl, debug = false }) {
  const cacheKey = `adsdir:${userId || "anonymous"}`;
  if (!store?.cached) {
    return { ...(await buildDirectory({ accounts, store, fetchImpl, debug })), fromCache: false };
  }
  // refresh: true drops the cached copy first, so the rebuild below repopulates it.
  if (refresh) await store.clearCached?.(cacheKey);
  const cached = await store.cached(cacheKey, DIRECTORY_TTL_SECONDS, async () => ({
    ok: true,
    ...(await buildDirectory({ accounts, store, fetchImpl, debug }))
  }));
  return { ...cached, fromCache: cached?.cached === true };
}

async function buildDirectory({ accounts, store, fetchImpl, debug }) {
  const byCustomerId = {};
  const notes = [];
  const googleAccounts = [];
  let requestCount = 0;

  for (const account of accounts || []) {
    const result = await buildAccountDirectoryForAccount({
      accessToken: account.accessToken,
      googleAccount: account.label,
      fetchImpl, store, debug
    });
    requestCount += result.requestCount;
    if (result.notes?.length) notes.push(...result.notes);
    googleAccounts.push({
      googleAccount: account.label,
      accounts: result.entries.length,
      empty: Boolean(result.empty),
      error: result.error || undefined
    });
    for (const entry of result.entries) {
      // First account that can see a customer owns it; a usable record beats an unusable one.
      const existing = byCustomerId[entry.customerId];
      if (!existing || (!existing.usable && entry.usable)) byCustomerId[entry.customerId] = entry;
    }
  }

  return { byCustomerId, googleAccounts, notes, requestCount, builtAt: new Date().toISOString() };
}

/* ---------------- lookups (items 7, 8) ---------------- */

export function directoryEntry(directory, customerId) {
  const wanted = normalizeCustomerId(customerId);
  return wanted ? directory?.byCustomerId?.[wanted] || null : null;
}

/** Every manager that could serve this customer, most likely first, for the retry ladder. */
export function managersFor(directory, customerId) {
  const entry = directoryEntry(directory, customerId);
  const managers = [];
  if (entry?.managerCustomerId) managers.push(entry.managerCustomerId);
  if (entry?.loginCustomerId) managers.push(entry.loginCustomerId);
  for (const candidate of Object.values(directory?.byCustomerId || {})) {
    if (candidate.isManager && candidate.usable) managers.push(candidate.customerId);
  }
  const wanted = normalizeCustomerId(customerId);
  return [...new Set(managers.filter((id) => id && id !== wanted))];
}

/** Every manager in the directory, for list_google_ads_customer_clients with no customerId (item 7). */
export function allManagers(directory) {
  return Object.values(directory?.byCustomerId || {}).filter((entry) => entry.isManager && entry.usable);
}

/**
 * Fuzzy account lookup by name (item 8). Returns { match } on a single clear winner, or
 * { candidates } when ambiguous -- never a guess.
 */
export function findByName(directory, customerName) {
  const wanted = String(customerName || "").trim().toLowerCase();
  if (!wanted) return { candidates: [] };
  const entries = Object.values(directory?.byCustomerId || {});

  const exact = entries.filter((entry) => String(entry.name || "").toLowerCase() === wanted);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { candidates: exact };

  const tokens = wanted.split(/\s+/).filter(Boolean);
  const scored = entries
    .map((entry) => {
      const name = String(entry.name || "").toLowerCase();
      if (!name) return null;
      const hits = tokens.filter((token) => name.includes(token)).length;
      if (!hits) return null;
      // Prefer entries matching every token, then shorter names (less incidental overlap).
      return { entry, hits, length: name.length };
    })
    .filter(Boolean)
    .sort((a, b) => b.hits - a.hits || a.length - b.length);

  if (!scored.length) return { candidates: [] };
  const best = scored.filter((candidate) => candidate.hits === scored[0].hits);
  if (best.length === 1) return { match: best[0].entry };
  return { candidates: best.map((candidate) => candidate.entry) };
}

/** The directory shaped for list_google_ads_accessible_customers (item 6). */
export function directoryListing(directory) {
  const accounts = Object.values(directory?.byCustomerId || {}).map((entry) => ({
    customerId: entry.customerId,
    name: entry.name,
    status: entry.status,
    isManager: entry.isManager,
    isTestAccount: entry.isTestAccount ?? false,
    currency: entry.currency ?? null,
    timeZone: entry.timeZone ?? null,
    googleAccount: entry.googleAccount,
    loginCustomerId: entry.managerCustomerId || entry.loginCustomerId,
    usable: entry.usable,
    usableReason: entry.usableReason,
    ...(entry.statusNote ? { statusNote: entry.statusNote } : {}),
    ...(entry.level === undefined ? {} : { level: entry.level })
  })).sort((a, b) => Number(b.usable) - Number(a.usable) || String(a.name || "").localeCompare(String(b.name || "")));

  return {
    accountCount: accounts.length,
    usableCount: accounts.filter((account) => account.usable).length,
    accounts,
    googleAccounts: directory?.googleAccounts || [],
    notes: directory?.notes || [],
    builtAt: directory?.builtAt || null
  };
}
