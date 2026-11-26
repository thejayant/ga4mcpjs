// A searchable index of everything this server can answer.
//
// The existing discovery tools are zero-input dumps covering three platforms. This builds
// one index across every platform, preset, normalized field and tool, so a model can ask
// "where do I get bounce rate / phone calls / branded traffic" and get back the exact tool
// and arguments to call.
//
// Everything is DERIVED from the live definitions that the tools themselves use. Nothing
// here is a hand-copied list, because a hand-maintained catalogue drifts from the code and
// then confidently points at things that no longer exist.

/** Which tool serves each platform's presets, so a match can say exactly what to call. */
export const PLATFORM_PRESET_TOOLS = Object.freeze({
  google_ads: { tool: "run_google_ads_preset", idArg: "customerId" },
  ga4: { tool: "run_ga4_preset", idArg: "propertyId" },
  search_console: { tool: "run_search_console_preset", idArg: "siteUrl" },
  merchant_center: { tool: "run_merchant_preset", idArg: "accountId" },
  meta: { tool: "run_meta_preset", idArg: "adAccountId" },
  callrail: { tool: "run_callrail_preset", idArg: "accountId" }
});

/**
 * Everyday words mapped to the vocabulary the APIs actually use. This is the layer that
 * lets "spend", "how much did we pay" and "cost" all reach cost_micros.
 */
export const SEARCH_SYNONYMS = Object.freeze({
  spend: ["cost", "cost_micros", "budget", "amount"],
  cost: ["spend", "cost_micros"],
  revenue: ["conversion_value", "purchaseRevenue", "totalRevenue", "conversions_value"],
  roas: ["conversion_value", "return on ad spend", "value_per_cost"],
  cpa: ["cost_per_conversion", "cost per acquisition"],
  cpc: ["average_cpc", "cost per click"],
  ctr: ["click through rate", "clicks", "impressions"],
  bounce: ["bounceRate", "engagementRate", "engagement"],
  calls: ["call", "callrail", "phone", "call_view", "phone_calls"],
  phone: ["call", "callrail", "call_view"],
  rankings: ["position", "average position", "query", "search_console"],
  ranking: ["position", "query"],
  keywords: ["keyword", "query", "search_term", "keyword_text"],
  traffic: ["sessions", "clicks", "users", "impressions"],
  visitors: ["users", "totalUsers", "activeUsers", "sessions"],
  conversions: ["key_events", "keyEvents", "conversions", "leads"],
  leads: ["conversions", "key_events", "call", "form"],
  branded: ["brandedClassification", "brand"],
  reviews: ["review", "rating", "gbp", "google_business_profile"],
  listings: ["product", "merchant_center", "local listing"],
  products: ["product", "merchant_center", "shopping"],
  video: ["youtube", "video_views", "views"],
  youtube: ["video", "channel", "views"],
  competitors: ["competitive_visibility", "benchmark", "auction insights"],
  demographics: ["age_range", "gender", "userAgeBracket", "userGender"],
  location: ["geo", "country", "region", "city", "geographic_view"],
  device: ["deviceType", "segments.device"],
  mobile: ["device", "deviceCategory"],
  budget: ["campaign_budget", "cost", "spend"],
  impressions: ["impressions", "reach"],
  reach: ["unique_users", "impressions", "reach"]
});

const WORD = /[a-z0-9_.]+/g;

export function tokenize(text) {
  return String(text || "").toLowerCase().match(WORD) || [];
}

/** Expands a query's tokens through the synonym map, keeping the originals. */
export function expandQuery(query) {
  const tokens = tokenize(query);
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const synonym of SEARCH_SYNONYMS[token] || []) {
      for (const part of tokenize(synonym)) expanded.add(part);
    }
  }
  return { tokens, expanded: [...expanded] };
}

function entry(fields) {
  // The searchable text for an entry: its id, title, description, keywords AND the
  // platform(s) it belongs to, so "search_console rankings" or "ga4 revenue" match the
  // right platform rather than relying on the description happening to name it.
  const platforms = Array.isArray(fields.platform) ? fields.platform : [fields.platform];
  const haystack = [fields.id, fields.title, fields.description, ...(fields.keywords || []), ...platforms.filter(Boolean)]
    .filter(Boolean).join(" ").toLowerCase();
  return { ...fields, haystack, haystackTokens: new Set(tokenize(haystack)) };
}

/**
 * Builds the index.
 *
 * @param {object} sources
 * @param {object} sources.presets        { platform: { presetName: definition } }
 * @param {object} sources.normalizedSchema the cross-platform schema, incl. crossSourceMappings
 * @param {object} sources.guardrails     PLATFORM_GUARDRAILS
 * @param {Array}  sources.tools          [{ name, platform, description }]
 */
export function buildMarketingCatalog({ presets = {}, normalizedSchema = {}, guardrails = {}, tools = [] } = {}) {
  const entries = [];

  // 1. Presets, per platform, with the exact call to make.
  for (const [platform, table] of Object.entries(presets)) {
    const serving = PLATFORM_PRESET_TOOLS[platform];
    for (const [name, definition] of Object.entries(table || {})) {
      entries.push(entry({
        kind: "preset",
        platform,
        id: name,
        title: name.replace(/_/g, " "),
        description: definition?.description || "",
        entityType: definition?.entityType || null,
        tool: serving?.tool || null,
        call: serving ? { tool: serving.tool, arguments: { preset: name, [serving.idArg]: `<${serving.idArg}>` } } : null,
        keywords: [
          ...(definition?.dimensions || []),
          definition?.resource,
          definition?.entityType,
          definition?.view,
          definition?.table
        ].filter(Boolean)
      }));
    }
  }

  // 2. Normalized fields, with the native field names on every platform that has them.
  // This is what answers "which platform even has this number".
  const mappings = normalizedSchema.crossSourceMappings || {};
  for (const [field, byPlatform] of Object.entries(mappings)) {
    const available = Object.entries(byPlatform).filter(([, names]) => (names || []).length);
    entries.push(entry({
      kind: "field",
      platform: available.map(([platform]) => platform),
      id: field,
      title: field.replace(/_/g, " "),
      description: available.length
        ? `Normalized field "${field}". Native names: ${available.map(([platform, names]) => `${platform}: ${names.join(", ")}`).join("; ")}.`
        : `Normalized field "${field}" has no native mapping on any connected platform.`,
      nativeFields: Object.fromEntries(available),
      unavailableOn: Object.entries(byPlatform).filter(([, names]) => !(names || []).length).map(([platform]) => platform),
      keywords: available.flatMap(([, names]) => names)
    }));
  }

  // 3. Standard dimensions and metrics that the normalizer emits.
  for (const [role, list] of [["dimension", normalizedSchema.standardDimensions], ["metric", normalizedSchema.standardMetrics]]) {
    for (const name of list || []) {
      if (mappings[name]) continue; // already covered, with richer detail
      entries.push(entry({
        kind: "field",
        role,
        platform: "normalized",
        id: name,
        title: name.replace(/_/g, " "),
        description: `Normalized ${role} "${name}", emitted by normalizeMarketingRecords and the preset normalizers.`,
        keywords: [role]
      }));
    }
  }

  // 4. Every registered tool.
  for (const tool of tools) {
    entries.push(entry({
      kind: "tool",
      platform: tool.platform || "other",
      id: tool.name,
      title: tool.name.replace(/_/g, " "),
      description: tool.description || "",
      tool: tool.name,
      call: { tool: tool.name, arguments: {} },
      keywords: tokenize(tool.name)
    }));
  }

  // 5. What is NOT available, taken from the guardrail prose. Telling a model that
  // something does not exist anywhere is as useful as telling it where to look, and stops
  // it inventing a tool call.
  const unavailable = [];
  for (const [platform, block] of Object.entries(guardrails)) {
    for (const limitation of block?.limitations || []) {
      if (/not exposed|no tool here|is not available|cannot be returned|does not expose/i.test(limitation)) {
        unavailable.push({ platform, limitation });
      }
    }
  }

  return {
    builtAt: new Date().toISOString(),
    entryCount: entries.length,
    platforms: [...new Set(entries.flatMap((item) => (Array.isArray(item.platform) ? item.platform : [item.platform])))].sort(),
    entries,
    unavailable
  };
}

/**
 * Ranks catalog entries against a query.
 *
 * Scoring favours, in order: an exact id match, a whole-token hit on the id or keywords,
 * then description text. Field entries get a small boost because "where do I get X" is
 * usually a question about a field rather than a preset name.
 */
export function searchCatalog(catalog, { query, platform, kind, limit = 12 } = {}) {
  const { tokens, expanded } = expandQuery(query);
  if (!tokens.length) return { query, matches: [], note: "Give a query, for example \"bounce rate\", \"phone calls\" or \"branded queries\"." };

  const wantedPlatforms = platform ? (Array.isArray(platform) ? platform : [platform]) : null;

  const scored = catalog.entries.map((item) => {
    const platforms = Array.isArray(item.platform) ? item.platform : [item.platform];
    if (wantedPlatforms && !platforms.some((name) => wantedPlatforms.includes(name))) return null;
    if (kind && item.kind !== kind) return null;

    let score = 0;
    const id = String(item.id).toLowerCase();
    const joined = tokens.join(" ");
    const joinedUnderscore = tokens.join("_");

    if (id === joined || id === joinedUnderscore) score += 100;
    else if (id.includes(joinedUnderscore) || id.includes(joined)) score += 40;

    for (const token of tokens) {
      if (item.haystackTokens.has(token)) score += 10;
      else if (item.haystack.includes(token)) score += 4;
    }
    // Synonym hits count, but less than the words the caller actually used.
    for (const token of expanded) {
      if (!tokens.includes(token) && item.haystackTokens.has(token)) score += 3;
    }
    if (!score) return null;
    if (item.kind === "field") score += 5;
    if (item.kind === "preset") score += 2;
    return { item, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)));

  const matches = scored.slice(0, limit).map(({ item, score }) => ({
    kind: item.kind,
    platform: item.platform,
    id: item.id,
    description: item.description,
    ...(item.entityType ? { entityType: item.entityType } : {}),
    ...(item.nativeFields ? { nativeFields: item.nativeFields } : {}),
    ...(item.unavailableOn?.length ? { notAvailableOn: item.unavailableOn } : {}),
    ...(item.call ? { call: item.call } : {}),
    relevance: score
  }));

  // Surface a known gap when the query looks like it is chasing something that does not exist.
  const blocked = catalog.unavailable.filter((item) =>
    tokens.some((token) => token.length > 3 && item.limitation.toLowerCase().includes(token))
  );

  return {
    query,
    matchCount: matches.length,
    matches,
    ...(blocked.length ? { notAvailable: blocked } : {}),
    ...(matches.length ? {} : {
      note: "Nothing matched. Try a metric or dimension name (\"cost\", \"position\", \"sessions\"), a platform name, or call list_marketing_presets to browse everything."
    })
  };
}
