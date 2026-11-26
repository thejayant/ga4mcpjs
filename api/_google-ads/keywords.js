// Google Ads Keyword Planner: request building, compact output, variant grouping,
// filtering/sorting and the v24+ forecast shape (items 10-17, 26).
//
// All three methods are read-only reads on KeywordPlanIdeaService. Google rate-limits them
// to 1 request/second per customer, and results are cached for 24h keyed on the whole
// request, so repeat research does not burn quota (item 16).

import { adsRequest, normalizeCustomerId } from "./client.js";
import { resolveGeoTargets, resolveLanguage } from "./geo.js";

export const PLANNER_CACHE_TTL_SECONDS = 24 * 60 * 60;

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

function toNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/** Micros -> currency units, rounded to 2 decimals (item 11). */
export function microsToCurrency(micros) {
  const numeric = toNumber(micros);
  return numeric === undefined ? null : Math.round((numeric / 1_000_000) * 100) / 100;
}

function round2(value) {
  return value === null || value === undefined ? null : Math.round(value * 100) / 100;
}

function monthIndex(month) {
  const index = MONTHS.indexOf(String(month || "").toUpperCase());
  return index === -1 ? null : index;
}

/* ---------------- monthly series -> compact summary (item 11) ---------------- */

export function monthlySeries(metrics) {
  return (metrics?.monthlySearchVolumes || [])
    .map((entry) => ({
      year: toNumber(entry.year) ?? null,
      month: entry.month || null,
      monthIndex: monthIndex(entry.month),
      searches: toNumber(entry.monthlySearches) ?? null
    }))
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || (a.monthIndex ?? 0) - (b.monthIndex ?? 0));
}

function label(entry) {
  return entry?.month && entry?.year ? `${entry.month} ${entry.year}` : null;
}

/**
 * The compact per-keyword summary: peak/low month, 3-month trend and year-on-year change,
 * instead of 12 raw monthly rows per keyword (item 11).
 */
export function summariseSeries(series) {
  const known = series.filter((entry) => entry.searches !== null);
  if (!known.length) return { peakMonth: null, lowMonth: null, trend3m: null, yoy: null, months: 0 };

  const peak = known.reduce((best, entry) => (entry.searches > best.searches ? entry : best), known[0]);
  const low = known.reduce((worst, entry) => (entry.searches < worst.searches ? entry : worst), known[0]);

  // trend3m: the latest 3 months against the 3 before them.
  const recent = known.slice(-3);
  const previous = known.slice(-6, -3);
  const sum = (rows) => rows.reduce((total, entry) => total + entry.searches, 0);
  const trend3m = previous.length === 3 && recent.length === 3 && sum(previous) > 0
    ? round2(((sum(recent) - sum(previous)) / sum(previous)) * 100)
    : null;

  // yoy: the latest month against the same month a year earlier.
  const latest = known[known.length - 1];
  const yearAgo = known.find((entry) => entry.monthIndex === latest.monthIndex && entry.year === (latest.year ?? 0) - 1);
  const yoy = yearAgo && yearAgo.searches > 0
    ? round2(((latest.searches - yearAgo.searches) / yearAgo.searches) * 100)
    : null;

  return {
    peakMonth: label(peak),
    peakSearches: peak.searches,
    lowMonth: label(low),
    lowSearches: low.searches,
    trend3m,
    yoy,
    latestMonth: label(latest),
    months: known.length
  };
}

/** One keyword row. `detail: "full"` keeps the 12 monthly rows; compact (default) does not. */
export function mapKeywordRow(row, { detail = "compact" } = {}) {
  const metrics = row.keywordIdeaMetrics || row.keywordMetrics || {};
  const series = monthlySeries(metrics);
  const summary = summariseSeries(series);
  const base = {
    keyword: row.text,
    avgMonthlySearches: toNumber(metrics.avgMonthlySearches) ?? null,
    competition: metrics.competition || null,
    competitionIndex: toNumber(metrics.competitionIndex) ?? null,
    lowTopOfPageBid: microsToCurrency(metrics.lowTopOfPageBidMicros),
    highTopOfPageBid: microsToCurrency(metrics.highTopOfPageBidMicros),
    avgCpc: microsToCurrency(metrics.averageCpcMicros),
    peakMonth: summary.peakMonth,
    lowMonth: summary.lowMonth,
    trend3m: summary.trend3m,
    yoy: summary.yoy
  };
  if (detail !== "full") return base;
  return {
    ...base,
    peakSearches: summary.peakSearches ?? null,
    lowSearches: summary.lowSearches ?? null,
    latestMonth: summary.latestMonth,
    closeVariants: row.closeVariants || undefined,
    monthlySearchVolumes: series.map(({ monthIndex: _drop, ...entry }) => entry)
  };
}

/* ---------------- variant grouping (item 12) ---------------- */

// Google groups close variants, so "metal buildings california" and "steel buildings
// california" come back with byte-identical metrics. Collapse them into one row.
function variantFingerprint(row, metrics) {
  const series = monthlySeries(metrics).map((entry) => `${entry.year}-${entry.monthIndex}:${entry.searches}`).join(",");
  return [
    toNumber(metrics.avgMonthlySearches) ?? "",
    toNumber(metrics.competitionIndex) ?? "",
    metrics.lowTopOfPageBidMicros ?? "",
    metrics.highTopOfPageBidMicros ?? "",
    series
  ].join("|");
}

/**
 * Collapses keywords whose monthly series and metrics are identical, listing the rest under
 * `variants` on a single row. Keeps the shortest keyword as the representative.
 */
export function groupVariants(rawRows, mapped) {
  const groups = new Map();
  rawRows.forEach((row, index) => {
    const metrics = row.keywordIdeaMetrics || row.keywordMetrics || {};
    const series = monthlySeries(metrics);
    // Rows with no volume history at all are not safely comparable; keep them separate.
    const fingerprint = series.length ? variantFingerprint(row, metrics) : `unique:${index}`;
    if (!groups.has(fingerprint)) groups.set(fingerprint, []);
    groups.get(fingerprint).push(mapped[index]);
  });

  return [...groups.values()].map((members) => {
    if (members.length === 1) return members[0];
    const sorted = [...members].sort((a, b) => String(a.keyword).length - String(b.keyword).length || String(a.keyword).localeCompare(String(b.keyword)));
    const [primary, ...rest] = sorted;
    return {
      ...primary,
      variants: rest.map((member) => member.keyword),
      variantCount: members.length,
      groupedNote: "Google reports identical metrics for these close variants, so they are one row."
    };
  });
}

/* ---------------- filters and sorting (item 15) ---------------- */

export function applyKeywordFilters(rows, params = {}) {
  const minVolume = toNumber(params.minVolume);
  const maxVolume = toNumber(params.maxVolume);
  const include = (params.includeTerms || []).map((term) => String(term).trim().toLowerCase()).filter(Boolean);
  const exclude = (params.excludeTerms || []).map((term) => String(term).trim().toLowerCase()).filter(Boolean);

  let filtered = rows.filter((row) => {
    const volume = row.avgMonthlySearches ?? 0;
    if (minVolume !== undefined && volume < minVolume) return false;
    if (maxVolume !== undefined && volume > maxVolume) return false;
    const keyword = String(row.keyword || "").toLowerCase();
    // includeTerms: keep rows containing at least one term.
    if (include.length && !include.some((term) => keyword.includes(term))) return false;
    // excludeTerms: drop rows containing any term (competitor brands, say).
    if (exclude.length && exclude.some((term) => keyword.includes(term))) return false;
    return true;
  });

  const sortBy = String(params.sortBy || "volume").toLowerCase();
  const key = {
    volume: (row) => row.avgMonthlySearches ?? -1,
    bid: (row) => row.highTopOfPageBid ?? row.lowTopOfPageBid ?? -1,
    competition: (row) => row.competitionIndex ?? -1
  }[sortBy] || ((row) => row.avgMonthlySearches ?? -1);

  filtered = [...filtered].sort((a, b) => key(b) - key(a) || String(a.keyword).localeCompare(String(b.keyword)));
  return filtered;
}

/* ---------------- request building ---------------- */

export const FORECAST_BIDDING_STRATEGIES = Object.freeze({
  // v26 CampaignToForecast.bidding_strategy oneof. Each metric Google returns depends on
  // which of these is chosen, which is why the response is not padded with zeros (item 26).
  manual_cpc: "manualCpcBiddingStrategy",
  maximize_clicks: "maximizeClicksBiddingStrategy",
  maximize_conversions: "maximizeConversionsBiddingStrategy"
});

function toMicros(amount) {
  const numeric = toNumber(amount);
  return numeric === undefined ? undefined : String(Math.round(numeric * 1_000_000));
}

/**
 * Builds the forecast campaign for the CURRENT (v24+) request shape.
 *
 * v24 removed CampaignToForecast.keyword_plan_network, CampaignToForecast.negative_keywords,
 * ForecastAdGroup.negative_keywords, ForecastAdGroup.max_cpc_bid_micros, BiddableKeyword and
 * CriterionBidModifier, and renamed geo_modifiers -> geo_target_constants and
 * biddable_keywords -> keywords. v26 CampaignToForecast accepts exactly four fields.
 */
export function buildForecastCampaign({ keywords, geoTargetConstants, language, biddingStrategy = "manual_cpc", maxCpcBid, dailyBudget, matchType = "PHRASE" }) {
  const strategyKey = FORECAST_BIDDING_STRATEGIES[String(biddingStrategy).toLowerCase()];
  if (!strategyKey) {
    throw plannerError(`Unknown biddingStrategy "${biddingStrategy}". Use one of: ${Object.keys(FORECAST_BIDDING_STRATEGIES).join(", ")}.`);
  }

  let strategy;
  if (strategyKey === "manualCpcBiddingStrategy") {
    // max_cpc_bid_micros is required for manual CPC.
    strategy = { manualCpcBiddingStrategy: { maxCpcBidMicros: toMicros(maxCpcBid ?? 1) } };
    if (dailyBudget !== undefined) strategy.manualCpcBiddingStrategy.dailyBudgetMicros = toMicros(dailyBudget);
  } else if (strategyKey === "maximizeClicksBiddingStrategy") {
    if (dailyBudget === undefined) throw plannerError("maximize_clicks needs dailyBudget (its daily target spend).");
    strategy = { maximizeClicksBiddingStrategy: { dailyTargetSpendMicros: toMicros(dailyBudget) } };
    if (maxCpcBid !== undefined) strategy.maximizeClicksBiddingStrategy.maxCpcBidCeilingMicros = toMicros(maxCpcBid);
  } else {
    if (dailyBudget === undefined) throw plannerError("maximize_conversions needs dailyBudget (its daily target spend).");
    strategy = { maximizeConversionsBiddingStrategy: { dailyTargetSpendMicros: toMicros(dailyBudget) } };
  }

  return {
    biddingStrategy: strategy,
    ...(geoTargetConstants?.length ? { geoTargetConstants } : {}),
    ...(language ? { languageConstants: [language] } : {}),
    adGroups: [{
      keywords: keywords.map((text) => ({ text, matchType }))
    }]
  };
}

/**
 * Only the fields Google actually returned, with no invented zeros (item 26).
 * v26 KeywordForecastMetrics has no impressions and no click_through_rate at all; clicks are
 * present only for manual CPC / maximize clicks, conversions only for maximize conversions.
 */
export function mapForecast(body, { biddingStrategy } = {}) {
  const metrics = body?.campaignForecastMetrics || {};
  const forecast = {};
  const put = (name, value) => { if (value !== undefined && value !== null) forecast[name] = value; };

  put("clicks", toNumber(metrics.clicks));
  put("conversions", toNumber(metrics.conversions));
  put("cost", microsToCurrency(metrics.costMicros));
  put("averageCpc", microsToCurrency(metrics.averageCpcMicros));
  put("averageCpa", microsToCurrency(metrics.averageCpaMicros));

  const absent = ["clicks", "conversions", "cost", "averageCpc", "averageCpa"].filter((name) => !(name in forecast));
  return {
    forecast,
    biddingStrategy: biddingStrategy || null,
    fieldsNotReturned: absent,
    note: "Google Ads v24 simplified this response: it returns only the metrics the chosen bidding strategy affects, and no longer returns impressions or CTR at all. Fields Google omitted are listed in fieldsNotReturned rather than reported as zero."
  };
}

export function plannerError(message) {
  const error = new Error(message);
  error.code = "INVALID_KEYWORD_PLANNER_REQUEST";
  return error;
}

/**
 * Validates the seed combination (item 14) and returns the seed object.
 * keywords + url => KeywordAndUrlSeed; keywords => KeywordSeed; url => UrlSeed; site => SiteSeed.
 */
export function buildSeed({ keywords = [], url, site }) {
  const cleaned = keywords.map((keyword) => String(keyword).trim()).filter(Boolean);
  const hasUrl = Boolean(String(url || "").trim());
  const hasSite = Boolean(String(site || "").trim());

  if (hasSite && (cleaned.length || hasUrl)) {
    throw plannerError("site cannot be combined with keywords or url: Google accepts exactly one seed. Use site on its own, or keywords and/or url together.");
  }
  if (cleaned.length && hasUrl) return { keywordAndUrlSeed: { keywords: cleaned, url: String(url).trim() } };
  if (cleaned.length) return { keywordSeed: { keywords: cleaned } };
  if (hasUrl) return { urlSeed: { url: String(url).trim() } };
  if (hasSite) return { siteSeed: { site: String(site).trim() } };
  throw plannerError("Keyword ideas need at least one seed: keywords, url, or site.");
}

/**
 * Builds the request for one keyword planner action.
 * Geo and language must already be resolved (see resolveTargeting).
 */
export function buildPlannerRequest(params, { geoTargetConstants, language }) {
  const customerId = normalizeCustomerId(params.customerId);
  const keywords = (params.keywords || []).map((keyword) => String(keyword).trim()).filter(Boolean);
  // Average CPC has to be asked for explicitly, on BOTH ideas and historical metrics (item 10).
  const historicalMetricsOptions = { includeAverageCpc: true };

  if (params.action === "ideas") {
    return {
      path: `customers/${customerId}:generateKeywordIdeas`,
      body: {
        ...buildSeed(params),
        ...(language ? { language } : {}),
        ...(geoTargetConstants?.length ? { geoTargetConstants } : {}),
        keywordPlanNetwork: params.network || "GOOGLE_SEARCH",
        includeAdultKeywords: Boolean(params.includeAdultKeywords),
        historicalMetricsOptions,
        // generateKeywordIdeas DOES still accept page_size (max 10,000); only
        // GoogleAdsService.search rejects it.
        ...(params.pageSize ? { pageSize: params.pageSize } : {}),
        ...(params.pageToken ? { pageToken: params.pageToken } : {})
      }
    };
  }

  if (params.action === "historical_metrics") {
    if (!keywords.length) throw plannerError("historical_metrics needs keywords.");
    return {
      path: `customers/${customerId}:generateKeywordHistoricalMetrics`,
      body: {
        keywords,
        ...(language ? { language } : {}),
        ...(geoTargetConstants?.length ? { geoTargetConstants } : {}),
        keywordPlanNetwork: params.network || "GOOGLE_SEARCH",
        includeAdultKeywords: Boolean(params.includeAdultKeywords),
        historicalMetricsOptions
      }
    };
  }

  if (params.action === "forecast") {
    if (!keywords.length) throw plannerError("forecast needs keywords.");
    return {
      path: `customers/${customerId}:generateKeywordForecastMetrics`,
      body: {
        ...(params.currencyCode ? { currencyCode: params.currencyCode } : {}),
        ...(params.forecastStartDate && params.forecastEndDate
          ? { forecastPeriod: { startDate: params.forecastStartDate, endDate: params.forecastEndDate } }
          : {}),
        campaign: buildForecastCampaign({
          keywords,
          geoTargetConstants,
          language,
          biddingStrategy: params.biddingStrategy,
          maxCpcBid: params.maxCpcBid,
          dailyBudget: params.dailyBudget,
          matchType: params.matchType
        })
      }
    };
  }

  throw plannerError(`Unsupported keyword planner action: ${params.action}`);
}

/** Resolves geoTargets/language names to constants, echoing what they became (item 13). */
export async function resolveTargeting(params, context) {
  const languageInput = params.language ?? "English";
  const resolvedLanguage = resolveLanguage(languageInput);
  if (languageInput && !resolvedLanguage) {
    throw plannerError(`Could not resolve the language "${languageInput}". Pass a language name such as "English", an ISO code such as "en", or Google's numeric ID.`);
  }

  const geo = await resolveGeoTargets({
    names: params.geoTargets || [],
    accessToken: context.accessToken,
    locale: params.geoLocale || "en",
    countryCode: params.geoCountryCode,
    store: context.store,
    fetchImpl: context.fetchImpl,
    debug: context.debug
  });

  if (geo.unresolved.length) {
    throw plannerError(`Could not resolve ${geo.unresolved.length === 1 ? "this location" : "these locations"}: ${geo.unresolved.join(", ")}. Try a fuller name ("Sacramento, California"), or pass Google's numeric geo target ID.`);
  }

  return {
    geoTargetConstants: geo.geoTargetConstants,
    language: resolvedLanguage?.resourceName,
    resolvedTargeting: {
      language: resolvedLanguage,
      locations: geo.resolved,
      requestCount: geo.requestCount
    }
  };
}

/** Stable cache key over the whole resolved request (item 16). */
export function plannerCacheKey(request, params) {
  const shape = {
    path: request.path,
    body: request.body,
    detail: params.detail || "compact",
    groupVariants: params.groupVariants !== false,
    filters: {
      minVolume: params.minVolume ?? null, maxVolume: params.maxVolume ?? null,
      includeTerms: [...(params.includeTerms || [])].sort(),
      excludeTerms: [...(params.excludeTerms || [])].sort(),
      sortBy: params.sortBy || "volume"
    }
  };
  // A short, stable digest; the key only has to be collision-free in practice.
  return `adskw:${hash(JSON.stringify(shape))}`;
}

function hash(text) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = (h1 ^ code) * 16777619 >>> 0;
    h2 = (h2 + code * 31 + index) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

/** Shapes a keyword response: map -> group -> filter/sort -> limit. */
export function shapeKeywordRows(rawRows, params) {
  const detail = params.detail === "full" ? "full" : "compact";
  const mapped = rawRows.map((row) => mapKeywordRow(row, { detail }));
  const grouped = params.groupVariants === false ? mapped : groupVariants(rawRows, mapped);
  const filtered = applyKeywordFilters(grouped, params);
  const limit = toNumber(params.limit);
  return {
    detail,
    keywordCount: filtered.length,
    keywords: limit ? filtered.slice(0, limit) : filtered,
    ...(limit && filtered.length > limit ? { truncatedTo: limit } : {})
  };
}

/**
 * Runs one keyword planner action end to end: resolve targeting, build, cache, call, shape.
 * Still one Google Ads request per call (plus at most one cached geo lookup).
 */
export async function runKeywordPlanner(params, context) {
  const targeting = await resolveTargeting(params, context);
  const request = buildPlannerRequest(params, targeting);
  const cacheKey = plannerCacheKey(request, params);

  const load = async () => {
    const response = await adsRequest({
      path: request.path,
      accessToken: context.accessToken,
      body: request.body,
      customerId: params.customerId,
      loginCustomerId: params.loginCustomerId,
      directoryEntry: context.directoryEntry,
      managerIds: context.managerIds || [],
      fetchImpl: context.fetchImpl,
      store: context.store,
      debug: params.debug
    });
    if (!response.ok) return { ok: false, error: response.error, attempts: response.attempts, quota: response.quota };
    return { ok: true, body: response.body, attempts: response.attempts, quota: response.quota };
  };

  const result = context.store?.cached && params.refresh !== true
    ? await context.store.cached(cacheKey, PLANNER_CACHE_TTL_SECONDS, load)
    : await load();

  const base = {
    action: params.action,
    resolvedTargeting: targeting.resolvedTargeting,
    cached: result.cached === true,
    requestCount: result.cached ? 0 : 1,
    quota: result.quota,
    attempts: result.attempts
  };

  if (!result.ok) return { ...base, ok: false, error: result.error };

  if (params.action === "forecast") {
    return { ...base, ok: true, ...mapForecast(result.body, { biddingStrategy: params.biddingStrategy || "manual_cpc" }) };
  }
  return {
    ...base,
    ok: true,
    ...shapeKeywordRows(result.body?.results || [], params),
    nextPageToken: result.body?.nextPageToken || null
  };
}

/* ---------------- item 17: batch keyword research ---------------- */

/**
 * Runs several seed groups and merges them into one deduped, clustered table.
 *
 * Google rate-limits Keyword Planner to 1 request/second per customer, so groups run
 * strictly sequentially. On the first quota error the run stops and returns the partial
 * result with a note, rather than hammering a limit that is already refusing.
 */
export async function runKeywordBatch({ groups, ...shared }, context) {
  const seedGroups = (groups || []).slice(0, shared.maxGroups || 10);
  if (!seedGroups.length) throw plannerError("keyword_research_batch needs at least one seed group.");

  const merged = new Map();
  const perGroup = [];
  const notes = [];
  let requestCount = 0;
  let stoppedEarly = false;

  for (const [index, group] of seedGroups.entries()) {
    const params = {
      ...shared,
      action: "ideas",
      keywords: group.keywords,
      url: group.url,
      site: group.site,
      // Grouping and filtering are applied to the merged table instead.
      groupVariants: false,
      limit: undefined
    };

    let result;
    try {
      result = await runKeywordPlanner(params, context);
    } catch (error) {
      perGroup.push({ group: group.label || `group ${index + 1}`, ok: false, error: error.message });
      continue;
    }
    requestCount += result.requestCount || 0;

    if (!result.ok) {
      perGroup.push({ group: group.label || `group ${index + 1}`, ok: false, error: result.error });
      if (result.error?.code === "QUOTA_EXCEEDED") {
        stoppedEarly = true;
        notes.push(`Stopped after ${index + 1} of ${seedGroups.length} seed groups: Google returned a quota or rate-limit error. The table below holds the groups that completed.`);
        break;
      }
      continue;
    }

    perGroup.push({
      group: group.label || `group ${index + 1}`,
      ok: true,
      keywords: result.keywordCount,
      cached: result.cached
    });

    for (const row of result.keywords) {
      const key = String(row.keyword).toLowerCase();
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...row, seedGroups: [group.label || `group ${index + 1}`] });
      } else if (!existing.seedGroups.includes(group.label || `group ${index + 1}`)) {
        // The same keyword found from several seeds: keep the richest row, record both seeds.
        existing.seedGroups.push(group.label || `group ${index + 1}`);
        if ((row.avgMonthlySearches ?? 0) > (existing.avgMonthlySearches ?? 0)) {
          Object.assign(existing, row, { seedGroups: existing.seedGroups });
        }
      }
    }
  }

  // Group variants and filter once, across the merged table.
  const rows = [...merged.values()];
  const clustered = clusterKeywords(applyKeywordFilters(rows, shared));
  const limit = toNumber(shared.limit);

  return {
    ok: perGroup.some((entry) => entry.ok),
    groupsRequested: seedGroups.length,
    groupsCompleted: perGroup.filter((entry) => entry.ok).length,
    requestCount,
    stoppedEarly,
    perGroup,
    notes,
    keywordCount: clustered.length,
    keywords: limit ? clustered.slice(0, limit) : clustered
  };
}

/**
 * Light clustering for the merged batch table: keywords are grouped by their most
 * distinctive shared token, so a report reads by theme rather than as one flat list.
 */
export function clusterKeywords(rows) {
  const STOP = new Set(["the", "a", "an", "for", "of", "in", "on", "and", "or", "to", "with", "near", "me", "best", "cheap", "my"]);
  const counts = new Map();
  for (const row of rows) {
    for (const token of new Set(String(row.keyword || "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP.has(word)))) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return rows.map((row) => {
    const tokens = [...new Set(String(row.keyword || "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP.has(word)))];
    // The token shared with the most other keywords names the cluster.
    const cluster = tokens.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b))[0] || "other";
    return { ...row, cluster };
  }).sort((a, b) => String(a.cluster).localeCompare(String(b.cluster)) || (b.avgMonthlySearches ?? 0) - (a.avgMonthlySearches ?? 0));
}
