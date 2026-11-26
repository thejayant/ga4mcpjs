// The central Google Ads request gate: the one chokepoint every Ads call goes through.
//
// HARD RULE: this MCP is strictly read-only against Google Ads. The Google Ads API has a
// single OAuth scope (adwords) and that scope permits writes, so there is no read-only
// scope to lean on -- the guarantee has to be enforced here, in our own code.
//
// Two independent checks, both of which must pass:
//   1. deny patterns  -- anything that looks like a write is refused outright
//   2. allowlist      -- the request must match one of the explicitly confirmed read RPCs
//
// A refused request throws before any socket is opened, so a blocked call never reaches
// Google. `assertReadOnly` is pure and synchronous precisely so it can be unit tested
// without a network stub.

export const ADS_READ_ONLY_ERROR = "ADS_READ_ONLY: write operations are disabled";

/**
 * The allowlist, keyed on "<resource pattern>:<method>" with numeric IDs collapsed to `*`.
 * Keying on the resource as well as the method (rather than the bare method name) keeps
 * the list unambiguous: `suggest` is only allowed on geoTargetConstants, nowhere else.
 *
 * Every entry below returns data and cannot change account state. Each was confirmed
 * against the v26 reference and by probing the live API for the exact REST path shape.
 */
export const ADS_ALLOWED_RPCS = Object.freeze({
  // GoogleAdsService -- GAQL reads. Cannot write: there is no mutate verb on this path.
  "customers/*/googleAds:search": { service: "GoogleAdsService", method: "Search", http: "POST" },
  "customers/*/googleAds:searchStream": { service: "GoogleAdsService", method: "SearchStream", http: "POST" },

  // CustomerService -- lists the customer IDs the OAuth user can reach.
  "customers:listAccessibleCustomers": { service: "CustomerService", method: "ListAccessibleCustomers", http: "GET" },

  // KeywordPlanIdeaService -- keyword research. Returns ideas/metrics; stores nothing.
  "customers/*:generateKeywordIdeas": { service: "KeywordPlanIdeaService", method: "GenerateKeywordIdeas", http: "POST" },
  "customers/*:generateKeywordHistoricalMetrics": { service: "KeywordPlanIdeaService", method: "GenerateKeywordHistoricalMetrics", http: "POST" },
  "customers/*:generateKeywordForecastMetrics": { service: "KeywordPlanIdeaService", method: "GenerateKeywordForecastMetrics", http: "POST" },

  // ReachPlanService -- read/plan methods. Forecasts only; creates no campaign.
  ":listPlannableLocations": { service: "ReachPlanService", method: "ListPlannableLocations", http: "POST" },
  ":listPlannableProducts": { service: "ReachPlanService", method: "ListPlannableProducts", http: "POST" },
  "customers/*:generateReachForecast": { service: "ReachPlanService", method: "GenerateReachForecast", http: "POST" },

  // BenchmarksService -- industry benchmark metrics (v25.2 percentile metrics).
  "customers/*:generateBenchmarksMetrics": { service: "BenchmarksService", method: "GenerateBenchmarksMetrics", http: "POST" },

  // GeoTargetConstantService -- resolves place names to geo target constants. Read-only:
  // it returns existing constants and does not create a resource.
  "geoTargetConstants:suggest": { service: "GeoTargetConstantService", method: "SuggestGeoTargetConstants", http: "POST" },

  // LocalServicesEligibilityService (v26.1) -- eligibility check, returns booleans/reasons.
  "customers/*:checkLocalServicesEligibility": { service: "LocalServicesEligibilityService", method: "CheckLocalServicesEligibility", http: "POST" },

  // GoogleAdsFieldService -- field metadata, for validating GAQL before running it.
  "googleAdsFields:search": { service: "GoogleAdsFieldService", method: "SearchGoogleAdsFields", http: "GET" },
  "googleAdsFields/*": { service: "GoogleAdsFieldService", method: "GetGoogleAdsField", http: "GET" }
});

/**
 * Deny patterns, applied to the request path AND to the serialized body. These are
 * redundant with the allowlist by design: if someone later widens the allowlist by
 * mistake, a write-shaped request still has to clear this.
 */
export const ADS_DENY_PATTERNS = Object.freeze([
  { name: "mutate", re: /mutate/i },
  { name: "apply", re: /\bapply/i },
  { name: "dismiss", re: /dismiss/i },
  { name: "upload", re: /upload/i },
  { name: "create", re: /create/i },
  { name: "update", re: /update/i },
  { name: "remove", re: /remove/i },
  { name: "draft-generation", re: /generate\w*draft/i },
  { name: "batch-job", re: /job/i },
  // Suggest* methods that would create a resource. SuggestGeoTargetConstants only reads,
  // so the pattern is anchored to the resource-creating variants.
  { name: "resource-creating-suggest", re: /suggest\w*(campaign|budget|asset|ad|creative)/i },
  // Any validate_only / validateOnly "dry run write" workaround.
  { name: "validate-only", re: /validate_?only/i }
]);

/**
 * The kill switch (item 25 / hard rule). GOOGLE_ADS_READ_ONLY defaults to true and there is
 * deliberately NO code path that turns enforcement off: this function reports what the env
 * asked for, but `assertReadOnly` never consults it. Setting it to false cannot enable
 * writes; it only produces a warning, so a future edit cannot quietly open the door.
 */
export function readOnlyFlagState() {
  const raw = process.env.GOOGLE_ADS_READ_ONLY;
  const requested = raw === undefined ? "true" : String(raw).trim().toLowerCase();
  return {
    enforced: true,
    requested,
    // True when someone tried to switch it off; surfaced so it shows up in logs/tests.
    ignoredOverride: requested !== "true"
  };
}

// Collapses the concrete path to its allowlist key: numeric IDs and field names become `*`.
export function adsRequestKey(path) {
  let target = String(path || "").trim().split("?")[0];
  // Absolute URLs: drop scheme and host first.
  target = target.replace(/^https?:\/\/[^/]+/, "");
  // Then any leading slashes, then the vNN segment -- in that order, so "/v26/..." normalizes too.
  target = target.replace(/^\/+/, "");
  // An absolute ReachPlan URL is ".../v26:listPlannableLocations" -> ":listPlannableLocations".
  target = target.replace(/^v\d+(?=:)/, "").replace(/^v\d+\//, "").replace(/^\/+/, "");
  const [resource, method] = target.includes(":")
    ? [target.slice(0, target.lastIndexOf(":")), target.slice(target.lastIndexOf(":") + 1)]
    : [target, null];
  // REST paths alternate collection/id: customers/{id}/googleAds, googleAdsFields/{name}.
  // Every id position (odd index) collapses to `*` so no account id can reach the allowlist key.
  const pattern = resource
    .split("/")
    .map((segment, index) => (index % 2 === 0 ? segment : "*"))
    .join("/");
  return method === null ? pattern : `${pattern}:${method}`;
}

function denyMatch(haystack) {
  return ADS_DENY_PATTERNS.find((pattern) => pattern.re.test(haystack)) || null;
}

/**
 * Throws ADS_READ_ONLY unless this exact request is a confirmed read. Pure and synchronous:
 * it opens no socket, so a blocked call provably never contacts Google.
 *
 * @returns the matched allowlist entry, for logging/quota accounting.
 */
export function assertReadOnly({ path, method = "POST", body, params } = {}) {
  const key = adsRequestKey(path);
  const serialized = `${String(path || "")} ${body === undefined ? "" : JSON.stringify(body)} ${params === undefined ? "" : JSON.stringify(params)}`;

  const denied = denyMatch(serialized);
  if (denied) throw adsReadOnlyError(key, `matched the blocked pattern "${denied.name}"`);

  const allowed = Object.prototype.hasOwnProperty.call(ADS_ALLOWED_RPCS, key) ? ADS_ALLOWED_RPCS[key] : null;
  if (!allowed) throw adsReadOnlyError(key, "is not on the read-only allowlist");

  const wanted = String(method || "POST").toUpperCase();
  if (allowed.http !== wanted) throw adsReadOnlyError(key, `must use HTTP ${allowed.http}, not ${wanted}`);

  return allowed;
}

export function adsReadOnlyError(key, why) {
  const error = new Error(ADS_READ_ONLY_ERROR);
  error.code = "ADS_READ_ONLY";
  error.adsRequestKey = key;
  error.reason = `${key} ${why}.`;
  // Nothing was sent: assertReadOnly runs before any fetch.
  error.contactedGoogle = false;
  return error;
}
