// GAQL input validation (hard rule, GAQL safety).
//
// query_google_ads and search_stream_google_ads can only ever reach Search/SearchStream,
// which have no write verb. Even so, anything that is not a plain SELECT ... FROM ...
// statement is refused, so a caller cannot smuggle another statement shape through.

export const GAQL_INVALID = "INVALID_QUERY";

// Statement keywords that have no business in a GAQL read. GAQL has no DML, but rejecting
// these by name turns a confusing API error into a clear local one.
const FORBIDDEN_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE",
  "MERGE", "UPSERT", "GRANT", "REVOKE", "EXEC", "CALL", "MUTATE"
];

/**
 * Returns the trimmed query, or throws an Error with code INVALID_QUERY.
 * @param {string} query
 */
export function assertSelectQuery(query) {
  const text = String(query ?? "").trim();
  if (!text) throw invalidQuery("The query is empty. GAQL reads look like: SELECT campaign.id FROM campaign.");

  // Strip quoted literals before keyword scanning so a campaign named "Update 2026" is fine.
  const withoutLiterals = text.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

  if (!/^SELECT\s/i.test(withoutLiterals)) {
    throw invalidQuery("GAQL must start with SELECT. Only SELECT ... FROM ... reads are allowed.");
  }
  if (!/\sFROM\s+[a-z_][a-z0-9_]*/i.test(withoutLiterals)) {
    throw invalidQuery("GAQL must name a resource with FROM, for example: SELECT campaign.id FROM campaign.");
  }
  // One statement only.
  if (/;\s*\S/.test(withoutLiterals)) {
    throw invalidQuery("Only one GAQL statement per call; remove the extra statement after the semicolon.");
  }
  const found = FORBIDDEN_KEYWORDS.find((keyword) => new RegExp(`(^|[^A-Z_])${keyword}([^A-Z_]|$)`, "i").test(withoutLiterals));
  if (found) {
    throw invalidQuery(`GAQL reads cannot contain ${found.toUpperCase()}. This server is read-only; use SELECT ... FROM ... only.`);
  }
  return text;
}

export function invalidQuery(message) {
  const error = new Error(message);
  error.code = GAQL_INVALID;
  return error;
}

// True when the query is a valid SELECT read, without throwing. For callers that branch.
export function isSelectQuery(query) {
  try {
    assertSelectQuery(query);
    return true;
  } catch {
    return false;
  }
}

/**
 * Appends/replaces a LIMIT on a GAQL query. v26 search has no pageSize, so a row ceiling
 * has to be expressed in the query itself (item 2).
 */
export function withGaqlLimit(query, limit) {
  const text = String(query).trim().replace(/;+\s*$/, "");
  const rows = Number(limit);
  if (!Number.isFinite(rows) || rows <= 0) return text;
  if (/\sLIMIT\s+\d+\s*$/i.test(text)) return text.replace(/\sLIMIT\s+\d+\s*$/i, ` LIMIT ${Math.floor(rows)}`);
  return `${text} LIMIT ${Math.floor(rows)}`;
}
