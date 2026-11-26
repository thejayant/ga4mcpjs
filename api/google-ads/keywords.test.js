import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyKeywordFilters, buildForecastCampaign, buildPlannerRequest, buildSeed,
  groupVariants, mapForecast, mapKeywordRow, microsToCurrency, plannerCacheKey,
  resolveTargeting, runKeywordPlanner, shapeKeywordRows, summariseSeries
} from "./keywords.js";

const MONTHS = ["DECEMBER", "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER"];

// 13 months so year-on-year has a comparison point.
function series(values, startYear = 2025) {
  return values.map((searches, index) => ({
    year: index === 0 ? startYear : startYear + 1,
    month: MONTHS[index % 12],
    monthlySearches: String(searches)
  }));
}

function ideaRow(text, searches, extra = {}) {
  return {
    text,
    keywordIdeaMetrics: {
      avgMonthlySearches: String(Math.round(searches.reduce((a, b) => a + b, 0) / searches.length)),
      competition: "MEDIUM",
      competitionIndex: "45",
      lowTopOfPageBidMicros: "1230000",
      highTopOfPageBidMicros: "4560000",
      monthlySearchVolumes: series(searches),
      ...extra
    }
  };
}

/* ---------------- item 10: averageCpc ---------------- */

test("ideas and historical_metrics both ask for average CPC", () => {
  for (const action of ["ideas", "historical_metrics"]) {
    const request = buildPlannerRequest(
      { action, customerId: "9529469947", keywords: ["metal buildings"] },
      { geoTargetConstants: ["geoTargetConstants/2840"], language: "languageConstants/1000" }
    );
    assert.equal(request.body.historicalMetricsOptions.includeAverageCpc, true, `${action} did not request average CPC`);
  }
});

test("average CPC micros map to currency, rounded to 2 decimals", () => {
  assert.equal(microsToCurrency("2345678"), 2.35);
  assert.equal(microsToCurrency("1000000"), 1);
  assert.equal(microsToCurrency(null), null);
  const row = mapKeywordRow(ideaRow("x", [100, 100, 100], { averageCpcMicros: "3456789" }));
  assert.equal(row.avgCpc, 3.46);
});

test("a row with no averageCpcMicros reports null rather than 0", () => {
  assert.equal(mapKeywordRow(ideaRow("x", [10, 10, 10])).avgCpc, null);
});

/* ---------------- item 11: compact output ---------------- */

test("compact output carries the summary fields and no monthly rows", () => {
  const row = mapKeywordRow(ideaRow("metal buildings", [100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 400]));
  for (const field of ["avgMonthlySearches", "competition", "competitionIndex", "lowTopOfPageBid", "highTopOfPageBid", "avgCpc", "peakMonth", "lowMonth", "trend3m", "yoy"]) {
    assert.ok(field in row, `compact output is missing ${field}`);
  }
  assert.ok(!("monthlySearchVolumes" in row), "compact output must not include 12 monthly rows");
  assert.equal(row.lowTopOfPageBid, 1.23);
  assert.equal(row.highTopOfPageBid, 4.56);
});

test("full detail keeps the monthly series", () => {
  const row = mapKeywordRow(ideaRow("x", [1, 2, 3]), { detail: "full" });
  assert.equal(row.monthlySearchVolumes.length, 3);
  assert.ok("peakSearches" in row);
});

test("peak, low, trend3m and yoy are computed from the series", () => {
  // 13 entries: Dec 2025 then Jan..Dec 2026.
  const summary = summariseSeries([
    { year: 2025, month: "DECEMBER", monthIndex: 11, searches: 100 },
    ...[200, 200, 200, 300, 300, 300, 100, 100, 100, 400, 400, 400].map((searches, index) => ({
      year: 2026, month: MONTHS[(index + 1) % 12], monthIndex: index, searches
    }))
  ]);
  assert.equal(summary.peakSearches, 400);
  assert.equal(summary.lowSearches, 100);
  // last 3 = 400*3 = 1200, previous 3 = 100*3 = 300 -> +300%
  assert.equal(summary.trend3m, 300);
  assert.equal(summary.months, 13);
});

test("a flat series reports a 0% trend, and a short series reports null", () => {
  const flat = summariseSeries([100, 100, 100, 100, 100, 100].map((searches, index) => ({ year: 2026, month: MONTHS[index], monthIndex: index, searches })));
  assert.equal(flat.trend3m, 0);
  const short = summariseSeries([{ year: 2026, month: "JANUARY", monthIndex: 0, searches: 50 }]);
  assert.equal(short.trend3m, null);
  assert.equal(short.yoy, null);
});

test("an empty series does not throw", () => {
  const row = mapKeywordRow({ text: "x", keywordIdeaMetrics: {} });
  assert.equal(row.peakMonth, null);
  assert.equal(row.trend3m, null);
});

/* ---------------- item 12: variant grouping ---------------- */

test("close variants with identical metrics collapse into one row", () => {
  // The reported case: these two came back byte-identical.
  const volumes = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220];
  const raw = [ideaRow("metal buildings california", volumes), ideaRow("steel buildings california", volumes)];
  const mapped = raw.map((row) => mapKeywordRow(row));
  const grouped = groupVariants(raw, mapped);

  assert.equal(grouped.length, 1, "identical variants were not grouped");
  assert.equal(grouped[0].keyword, "metal buildings california", "the shortest keyword should represent the group");
  assert.deepEqual(grouped[0].variants, ["steel buildings california"]);
  assert.equal(grouped[0].variantCount, 2);
});

test("keywords with different metrics are kept apart", () => {
  const raw = [ideaRow("a", [100, 100, 100]), ideaRow("b", [900, 900, 900])];
  const grouped = groupVariants(raw, raw.map((row) => mapKeywordRow(row)));
  assert.equal(grouped.length, 2);
  assert.ok(!grouped.some((row) => row.variants));
});

test("rows with no volume history are never grouped together", () => {
  const raw = [{ text: "a", keywordIdeaMetrics: {} }, { text: "b", keywordIdeaMetrics: {} }];
  const grouped = groupVariants(raw, raw.map((row) => mapKeywordRow(row)));
  assert.equal(grouped.length, 2, "keywords with no data are not evidence of being variants");
});

test("grouping can be turned off", () => {
  const volumes = [100, 110, 120];
  const raw = [ideaRow("a b", volumes), ideaRow("c d", volumes)];
  assert.equal(shapeKeywordRows(raw, { groupVariants: false }).keywordCount, 2);
  assert.equal(shapeKeywordRows(raw, {}).keywordCount, 1);
});

/* ---------------- item 15: filters and sorting ---------------- */

const FILTER_ROWS = [
  { keyword: "metal buildings", avgMonthlySearches: 1000, highTopOfPageBid: 5, competitionIndex: 10 },
  { keyword: "steel buildings cheap", avgMonthlySearches: 50, highTopOfPageBid: 9, competitionIndex: 90 },
  { keyword: "morton buildings reviews", avgMonthlySearches: 500, highTopOfPageBid: 1, competitionIndex: 50 }
];

test("minVolume and maxVolume filter by search volume", () => {
  assert.deepEqual(applyKeywordFilters(FILTER_ROWS, { minVolume: 100 }).map((r) => r.keyword), ["metal buildings", "morton buildings reviews"]);
  assert.deepEqual(applyKeywordFilters(FILTER_ROWS, { maxVolume: 100 }).map((r) => r.keyword), ["steel buildings cheap"]);
});

test("excludeTerms drops competitor brands and includeTerms keeps a theme", () => {
  assert.ok(!applyKeywordFilters(FILTER_ROWS, { excludeTerms: ["morton"] }).some((r) => r.keyword.includes("morton")));
  assert.deepEqual(applyKeywordFilters(FILTER_ROWS, { includeTerms: ["steel"] }).map((r) => r.keyword), ["steel buildings cheap"]);
});

test("sortBy orders by volume, bid or competition", () => {
  assert.equal(applyKeywordFilters(FILTER_ROWS, { sortBy: "volume" })[0].keyword, "metal buildings");
  assert.equal(applyKeywordFilters(FILTER_ROWS, { sortBy: "bid" })[0].keyword, "steel buildings cheap");
  assert.equal(applyKeywordFilters(FILTER_ROWS, { sortBy: "competition" })[0].keyword, "steel buildings cheap");
});

/* ---------------- item 14: seeds ---------------- */

test("seed combinations map to the right seed type", () => {
  assert.deepEqual(buildSeed({ keywords: ["a"] }), { keywordSeed: { keywords: ["a"] } });
  assert.deepEqual(buildSeed({ url: "https://x.com" }), { urlSeed: { url: "https://x.com" } });
  assert.deepEqual(buildSeed({ site: "x.com" }), { siteSeed: { site: "x.com" } });
  assert.deepEqual(buildSeed({ keywords: ["a"], url: "https://x.com" }), { keywordAndUrlSeed: { keywords: ["a"], url: "https://x.com" } });
});

test("an invalid seed combination is a clear error", () => {
  assert.throws(() => buildSeed({ site: "x.com", keywords: ["a"] }), /site cannot be combined/);
  assert.throws(() => buildSeed({ site: "x.com", url: "https://x.com" }), /site cannot be combined/);
  assert.throws(() => buildSeed({}), /at least one seed/);
});

/* ---------------- item 26: the v24+ forecast shape ---------------- */

test("the forecast campaign uses only fields v26 still accepts", () => {
  const campaign = buildForecastCampaign({
    keywords: ["metal buildings"],
    geoTargetConstants: ["geoTargetConstants/21137"],
    language: "languageConstants/1000",
    maxCpcBid: 2
  });
  assert.deepEqual(Object.keys(campaign).sort(), ["adGroups", "biddingStrategy", "geoTargetConstants", "languageConstants"]);
  // Fields v24 removed must not reappear.
  const serialized = JSON.stringify(campaign);
  for (const removed of ["keywordPlanNetwork", "negativeKeywords", "geoModifiers", "biddableKeywords", "maxCpcBidMicros\":null", "criterionBidModifier"]) {
    assert.ok(!serialized.includes(removed), `${removed} was removed in v24 but is still sent`);
  }
  assert.deepEqual(campaign.adGroups[0].keywords, [{ text: "metal buildings", matchType: "PHRASE" }]);
});

test("each bidding strategy sends the fields Google requires", () => {
  assert.equal(buildForecastCampaign({ keywords: ["a"], biddingStrategy: "manual_cpc", maxCpcBid: 3 }).biddingStrategy.manualCpcBiddingStrategy.maxCpcBidMicros, "3000000");
  assert.equal(buildForecastCampaign({ keywords: ["a"], biddingStrategy: "maximize_clicks", dailyBudget: 50 }).biddingStrategy.maximizeClicksBiddingStrategy.dailyTargetSpendMicros, "50000000");
  assert.equal(buildForecastCampaign({ keywords: ["a"], biddingStrategy: "maximize_conversions", dailyBudget: 80 }).biddingStrategy.maximizeConversionsBiddingStrategy.dailyTargetSpendMicros, "80000000");
});

test("a bidding strategy missing its required budget is a clear error", () => {
  assert.throws(() => buildForecastCampaign({ keywords: ["a"], biddingStrategy: "maximize_clicks" }), /needs dailyBudget/);
  assert.throws(() => buildForecastCampaign({ keywords: ["a"], biddingStrategy: "nonsense" }), /Unknown biddingStrategy/);
});

test("forecast output reports only what Google returned, with no fake zeros", () => {
  // Maximize clicks returns clicks and cost, but never conversions, impressions or CTR.
  const mapped = mapForecast({ campaignForecastMetrics: { clicks: 120.5, costMicros: "45000000", averageCpcMicros: "373134" } }, { biddingStrategy: "maximize_clicks" });
  assert.equal(mapped.forecast.clicks, 120.5);
  assert.equal(mapped.forecast.cost, 45);
  assert.equal(mapped.forecast.averageCpc, 0.37);
  assert.ok(!("conversions" in mapped.forecast), "conversions must be absent, not zero");
  assert.ok(!("impressions" in mapped.forecast), "v26 does not return impressions at all");
  assert.ok(!("ctr" in mapped.forecast));
  assert.ok(mapped.fieldsNotReturned.includes("conversions"));
});

test("an empty forecast response reports every field as not returned", () => {
  const mapped = mapForecast({}, { biddingStrategy: "manual_cpc" });
  assert.deepEqual(mapped.forecast, {});
  assert.equal(mapped.fieldsNotReturned.length, 5);
});

/* ---------------- item 13: geo and language resolution ---------------- */

function geoStub(suggestions) {
  return async (url, init) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(
      url.includes("geoTargetConstants:suggest")
        ? { geoTargetConstantSuggestions: suggestions }
        : { results: [] }
    )
  });
}

const CALIFORNIA = { geoTargetConstant: { resourceName: "geoTargetConstants/21137", name: "California", canonicalName: "California,United States", targetType: "STATE", countryCode: "US" }, reach: 39000000 };
const SACRAMENTO = { geoTargetConstant: { resourceName: "geoTargetConstants/1014044", name: "Sacramento", canonicalName: "Sacramento,California,United States", targetType: "CITY", countryCode: "US" }, reach: 2000000 };

test("place names resolve to geo target constants and are echoed back", async () => {
  const resolved = await resolveTargeting(
    { geoTargets: ["California"], language: "English" },
    { accessToken: "t", fetchImpl: geoStub([CALIFORNIA]) }
  );
  assert.deepEqual(resolved.geoTargetConstants, ["geoTargetConstants/21137"]);
  assert.equal(resolved.language, "languageConstants/1000");
  // The response has to show what the names became.
  assert.equal(resolved.resolvedTargeting.locations[0].input, "California");
  assert.equal(resolved.resolvedTargeting.locations[0].id, "21137");
  assert.equal(resolved.resolvedTargeting.locations[0].canonicalName, "California,United States");
  assert.equal(resolved.resolvedTargeting.language.id, "1000");
});

test('"Sacramento, CA" picks the city, not the state', async () => {
  const resolved = await resolveTargeting(
    { geoTargets: ["Sacramento, California"] },
    { accessToken: "t", fetchImpl: geoStub([SACRAMENTO, CALIFORNIA]) }
  );
  assert.deepEqual(resolved.geoTargetConstants, ["geoTargetConstants/1014044"]);
});

test("numeric geo ids need no API call", async () => {
  let called = 0;
  const resolved = await resolveTargeting(
    { geoTargets: ["2840", "geoTargetConstants/21137"] },
    { accessToken: "t", fetchImpl: async () => { called += 1; throw new Error("should not be called"); } }
  );
  assert.equal(called, 0);
  assert.deepEqual(resolved.geoTargetConstants, ["geoTargetConstants/2840", "geoTargetConstants/21137"]);
});

test("an unresolvable place name is a clear error, not a silent default", async () => {
  await assert.rejects(
    () => resolveTargeting({ geoTargets: ["Nowhereville"] }, { accessToken: "t", fetchImpl: geoStub([]) }),
    /Could not resolve this location: Nowhereville/
  );
});

test("an unknown language name is a clear error", async () => {
  await assert.rejects(
    () => resolveTargeting({ language: "Klingon" }, { accessToken: "t", fetchImpl: geoStub([]) }),
    /Could not resolve the language "Klingon"/
  );
});

/* ---------------- item 16: caching ---------------- */

test("the cache key covers the request and the output options", () => {
  const request = { path: "customers/1:generateKeywordIdeas", body: { keywordSeed: { keywords: ["a"] } } };
  const base = plannerCacheKey(request, { detail: "compact" });
  assert.equal(base, plannerCacheKey(request, { detail: "compact" }), "the key must be stable");
  assert.notEqual(base, plannerCacheKey(request, { detail: "full" }), "detail must change the key");
  assert.notEqual(base, plannerCacheKey(request, { detail: "compact", excludeTerms: ["morton"] }), "filters must change the key");
  assert.notEqual(base, plannerCacheKey({ ...request, body: { keywordSeed: { keywords: ["b"] } } }, { detail: "compact" }));
});

test("a repeat request is served from cache without a second API call", async () => {
  const cache = new Map();
  const store = {
    cached: async (key, ttl, load) => {
      if (cache.has(key)) return { ...cache.get(key), cached: true };
      const fresh = await load();
      if (fresh?.ok) cache.set(key, fresh);
      return fresh;
    },
    clearCached: async (key) => cache.delete(key)
  };
  let apiCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes("generateKeywordIdeas")) apiCalls += 1;
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ results: [ideaRow("metal buildings", [100, 110, 120])] })
    };
  };
  const params = { action: "ideas", customerId: "9529469947", keywords: ["metal buildings"], geoTargets: ["2840"] };
  const context = { accessToken: "t", store, fetchImpl };

  const first = await runKeywordPlanner(params, context);
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(first.requestCount, 1);
  assert.equal(apiCalls, 1);

  const second = await runKeywordPlanner(params, context);
  assert.equal(second.cached, true);
  assert.equal(second.requestCount, 0, "a cached call must not count against quota");
  assert.equal(apiCalls, 1, "the second call must not hit the API");

  const forced = await runKeywordPlanner({ ...params, refresh: true }, context);
  assert.equal(forced.cached, false);
  assert.equal(apiCalls, 2, "refresh: true must bypass the cache");
});

test("the planner shapes rows end to end: group, filter, sort, limit", async () => {
  const volumes = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 300];
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      results: [
        ideaRow("metal buildings california", volumes),
        ideaRow("steel buildings california", volumes),
        ideaRow("morton buildings california", [900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900]),
        ideaRow("tiny niche term", [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5])
      ]
    })
  });
  const result = await runKeywordPlanner({
    action: "ideas", customerId: "1", keywords: ["metal buildings"], geoTargets: ["2840"],
    excludeTerms: ["morton"], minVolume: 10, sortBy: "volume"
  }, { accessToken: "t", fetchImpl });

  assert.equal(result.ok, true);
  // The two identical variants grouped; morton excluded; the 5/mo term filtered out.
  assert.deepEqual(result.keywords.map((row) => row.keyword), ["metal buildings california"]);
  assert.deepEqual(result.keywords[0].variants, ["steel buildings california"]);
  assert.equal(result.detail, "compact");
});

/* ---------------- item 17: batch ---------------- */

import { clusterKeywords, runKeywordBatch } from "./keywords.js";

function batchStub(byKeyword, { failAfter } = {}) {
  let calls = 0;
  const impl = async (url, init) => {
    if (!url.includes("generateKeywordIdeas")) return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    calls += 1;
    if (failAfter && calls > failAfter) {
      return {
        ok: false, status: 429,
        text: async () => JSON.stringify({ error: { message: "slow down", details: [{ errors: [{ errorCode: { quotaError: "RESOURCE_EXHAUSTED" } }] }] } })
      };
    }
    const seed = JSON.parse(init.body).keywordSeed?.keywords?.[0];
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: byKeyword[seed] || [] }) };
  };
  return { impl, get calls() { return calls; } };
}

test("batch merges and dedupes seed groups into one table", async () => {
  const stub = batchStub({
    "metal buildings": [ideaRow("metal buildings california", [100, 110, 120]), ideaRow("shared term", [700, 700, 700])],
    "steel garages": [ideaRow("steel garage kits", [300, 310, 320]), ideaRow("shared term", [700, 700, 700])]
  });
  const result = await runKeywordBatch({
    groups: [{ label: "buildings", keywords: ["metal buildings"] }, { label: "garages", keywords: ["steel garages"] }],
    customerId: "1", geoTargets: ["2840"]
  }, { accessToken: "t", fetchImpl: stub.impl });

  assert.equal(result.ok, true);
  assert.equal(result.groupsCompleted, 2);
  // "shared term" appears once, tagged with both seed groups.
  const shared = result.keywords.filter((row) => row.keyword === "shared term");
  assert.equal(shared.length, 1, "the duplicate keyword was not deduped");
  assert.deepEqual(shared[0].seedGroups, ["buildings", "garages"]);
  assert.equal(result.keywordCount, 3);
  assert.ok(result.keywords.every((row) => row.cluster), "every row should carry a cluster");
});

test("batch runs groups sequentially and stops early on a quota error, keeping partials", async () => {
  const stub = batchStub({
    "a": [ideaRow("a one", [10, 10, 10])],
    "b": [ideaRow("b one", [20, 20, 20])],
    "c": [ideaRow("c one", [30, 30, 30])]
  }, { failAfter: 1 });

  const result = await runKeywordBatch({
    groups: [{ label: "a", keywords: ["a"] }, { label: "b", keywords: ["b"] }, { label: "c", keywords: ["c"] }],
    customerId: "1", geoTargets: ["2840"]
  }, { accessToken: "t", fetchImpl: stub.impl });

  assert.equal(result.stoppedEarly, true);
  assert.equal(result.groupsCompleted, 1);
  // It must not have tried the third group after the quota error on the second.
  assert.equal(stub.calls, 2);
  assert.equal(result.keywordCount, 1, "the completed group's rows are still returned");
  assert.match(result.notes[0], /Stopped after 2 of 3/);
});

test("clustering names each group after its most shared token", () => {
  const clustered = clusterKeywords([
    { keyword: "metal buildings california", avgMonthlySearches: 100 },
    { keyword: "metal buildings texas", avgMonthlySearches: 200 },
    { keyword: "steel garage kits", avgMonthlySearches: 50 }
  ]);
  const buildings = clustered.filter((row) => row.cluster === "buildings");
  assert.equal(buildings.length, 2);
  // Within a cluster, higher volume first.
  assert.equal(buildings[0].avgMonthlySearches, 200);
});

test("batch needs at least one group", async () => {
  await assert.rejects(() => runKeywordBatch({ groups: [] }, { accessToken: "t" }), /at least one seed group/);
});
