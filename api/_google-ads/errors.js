// Normalized Google Ads errors (item 18).
//
// Google's failures arrive in several shapes (REST error object, searchStream's array
// envelope, bare HTTP failures). Everything is mapped onto a small, stable set of codes
// with a `fix` the model can act on, so tools stop leaking raw Google payloads by default.
//
// `raw` is attached only when the caller passes debug: true (item 18), and the serializer
// strips credentials in every case (item 23).

import { googleAdsVersionInfo } from "./version.js";

export const ADS_ERROR_CODES = Object.freeze({
  PERMISSION_DENIED: "PERMISSION_DENIED",
  ACCOUNT_DEACTIVATED: "ACCOUNT_DEACTIVATED",
  NEEDS_MANAGER_HEADER: "NEEDS_MANAGER_HEADER",
  INVALID_QUERY: "INVALID_QUERY",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  DEV_TOKEN_NOT_APPROVED: "DEV_TOKEN_NOT_APPROVED",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  READ_ONLY_BLOCKED: "ADS_READ_ONLY",
  UNKNOWN: "UNKNOWN"
});

// Header and body keys that must never appear in tool output (item 23).
const SECRET_KEY = /^(authorization|developer-token|login-customer-id|cookie|set-cookie|x-goog-api-key)$/i;
const SECRET_VALUE = /\b(ya29\.[\w.-]+|1\/\/[\w.-]{20,}|Bearer\s+[\w.-]+)/gi;

/**
 * Deep-redacts anything credential-shaped. Used for every `raw` payload and every log line,
 * so a developer token or refresh token cannot reach LLM context or chat logs.
 */
export function redactSecrets(value, depth = 0) {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]");
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
      SECRET_KEY.test(String(key).trim()) ? [key, "[redacted]"] : [key, redactSecrets(entry, depth + 1)]
    ));
  }
  return value;
}

// Pulls the Google error object out of whichever envelope it arrived in.
function unwrap(body) {
  if (!body) return {};
  if (Array.isArray(body)) return body.find((entry) => entry?.error)?.error || {};
  return body.error || {};
}

/** Every Google Ads error enum present anywhere in the payload. */
export function googleAdsErrorCodes(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return [...new Set([...text.matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)].map((match) => match[1]))];
}

export function googleAdsRequestId(response) {
  const body = response?.body;
  const error = unwrap(body);
  return error.details?.find?.((detail) => detail.requestId)?.requestId
    || (typeof body === "object" && body !== null && !Array.isArray(body) ? body.requestId : null)
    || response?.headers?.["request-id"]
    || null;
}

const RULES = [
  {
    code: ADS_ERROR_CODES.ACCOUNT_DEACTIVATED,
    enums: ["CUSTOMER_NOT_ENABLED"],
    message: "This Google Ads account is deactivated (cancelled, suspended, or setup was never finished).",
    fix: "Nothing to retry: the account cannot serve data in any state. Use an enabled account; list_google_ads_accessible_customers marks each one usable or not."
  },
  {
    code: ADS_ERROR_CODES.NEEDS_MANAGER_HEADER,
    enums: ["NOT_ADS_USER", "CUSTOMER_NOT_FOUND"],
    message: "Google could not resolve this customer for the signed-in user, which usually means the manager header was missing or wrong.",
    fix: "Retry with loginCustomerId set to the manager that owns this account. The account directory does this automatically once it is built."
  },
  {
    code: ADS_ERROR_CODES.PERMISSION_DENIED,
    enums: ["USER_PERMISSION_DENIED", "CUSTOMER_NOT_ACCESSIBLE"],
    message: "The connected Google user cannot read this Google Ads account with the header that was sent.",
    fix: "The account is either not linked to this login, or it sits under a manager that must be sent as login-customer-id. The retry ladder tries the account itself and then each known manager; `attempts` in the response shows what was tried."
  },
  {
    code: ADS_ERROR_CODES.QUOTA_EXCEEDED,
    enums: ["RESOURCE_EXHAUSTED", "RESOURCE_TEMPORARILY_EXHAUSTED", "QUOTA_ERROR", "TOO_MANY_REQUESTS"],
    message: "Google Ads API quota or rate limit reached.",
    fix: "Daily operation limits are per Google Cloud project (Explorer 2,880/day, Basic 15,000/day, Standard unlimited). Keyword Planner methods are additionally capped at 1 request/second per customer. Wait and retry, or widen one query instead of running several."
  },
  {
    code: ADS_ERROR_CODES.DEV_TOKEN_NOT_APPROVED,
    enums: [
      "DEVELOPER_TOKEN_NOT_APPROVED", "DEVELOPER_TOKEN_PROHIBITED", "INVALID_DEVELOPER_TOKEN",
      "DEVELOPER_TOKEN_PARAMETER_MISSING", "AUTHORIZATION_ERROR"
    ],
    message: "The Google Cloud project behind these OAuth credentials is not approved for this level of Google Ads API access.",
    fix: "Since the 2026-09-09 developer token sunset, access level belongs to the Cloud project that issued the OAuth client, not to a token. Check and apply on that project's Google Ads API overview page in the Cloud console."
  },
  {
    code: ADS_ERROR_CODES.AUTH_EXPIRED,
    enums: ["UNAUTHENTICATED", "EXPIRED_ACCESS_TOKEN", "INVALID_CREDENTIALS", "OAUTH_TOKEN_REVOKED", "USER_TOKEN_EXPIRED"],
    message: "The Google sign-in for this account is no longer valid.",
    fix: "Reconnect the Google account from manage_connections, then retry."
  },
  {
    code: ADS_ERROR_CODES.INVALID_QUERY,
    enums: [
      "QUERY_ERROR", "BAD_FIELD_NAME", "INVALID_FIELD_NAME", "UNRECOGNIZED_FIELD",
      "PROHIBITED_FIELD_COMBINATION_IN_SELECT_CLAUSE", "BAD_RESOURCE_TYPE_IN_FROM_CLAUSE",
      "PAGE_SIZE_NOT_SUPPORTED", "UNEXPECTED_END_OF_QUERY", "INVALID_ARGUMENT", "REQUEST_ERROR"
    ],
    message: "Google rejected the request shape or a field in the query.",
    fix: "Check field names with search_google_ads_fields. Note that v26 search takes no pageSize: express a row ceiling as a GAQL LIMIT instead."
  }
];

const HTTP_FALLBACK = {
  400: ADS_ERROR_CODES.INVALID_QUERY,
  401: ADS_ERROR_CODES.AUTH_EXPIRED,
  403: ADS_ERROR_CODES.PERMISSION_DENIED,
  404: ADS_ERROR_CODES.NEEDS_MANAGER_HEADER,
  429: ADS_ERROR_CODES.QUOTA_EXCEEDED
};

/**
 * Maps a failed Ads response onto { code, message, fix, requestId } (+ raw when debug).
 * @param {{status:number, body:any}} response
 * @param {{debug?:boolean, attempts?:any[]}} [options]
 */
export function normalizeAdsError(response, options = {}) {
  const enums = googleAdsErrorCodes(response?.body);
  const google = unwrap(response?.body);
  const matched = RULES.find((rule) => rule.enums.some((name) => enums.includes(name)));
  const code = matched?.code || HTTP_FALLBACK[response?.status] || ADS_ERROR_CODES.UNKNOWN;
  const rule = matched || RULES.find((entry) => entry.code === code);

  const normalized = {
    code,
    message: rule?.message || google.message || `Google Ads returned HTTP ${response?.status ?? "?"}.`,
    fix: rule?.fix || "Check the request against the Google Ads API reference for this version.",
    requestId: googleAdsRequestId(response),
    status: response?.status ?? null,
    googleMessage: google.message ? redactSecrets(google.message) : null,
    googleErrorCodes: enums.slice(0, 12),
    // Logged on every error so the next version bump is obvious (item 21).
    api: googleAdsVersionInfo()
  };
  if (options.attempts?.length) normalized.attempts = options.attempts;
  if (options.debug) normalized.raw = redactSecrets(response?.body);
  return normalized;
}

/** A thrown local error (gate refusal, bad GAQL) in the same shape. */
export function normalizeLocalError(error, options = {}) {
  const code = error?.code === "ADS_READ_ONLY"
    ? ADS_ERROR_CODES.READ_ONLY_BLOCKED
    : error?.code === "INVALID_QUERY" ? ADS_ERROR_CODES.INVALID_QUERY : ADS_ERROR_CODES.UNKNOWN;
  const normalized = {
    code,
    message: error instanceof Error ? error.message : String(error),
    fix: code === ADS_ERROR_CODES.READ_ONLY_BLOCKED
      ? "This server is read-only against Google Ads and will not perform this operation. Nothing was sent to Google."
      : "Fix the query and retry.",
    requestId: null,
    status: null,
    api: googleAdsVersionInfo()
  };
  if (error?.reason) normalized.detail = error.reason;
  if (options.debug && error?.stack) normalized.raw = { stack: String(error.stack).split("\n").slice(0, 4) };
  return normalized;
}

export function isPermissionDenied(response) {
  return googleAdsErrorCodes(response?.body).includes("USER_PERMISSION_DENIED");
}

export function isCustomerNotEnabled(response) {
  return googleAdsErrorCodes(response?.body).includes("CUSTOMER_NOT_ENABLED");
}
