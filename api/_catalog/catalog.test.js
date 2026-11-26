import assert from "node:assert/strict";
import { test } from "node:test";
import { PLATFORM_PRESET_TOOLS, buildMarketingCatalog, expandQuery, searchCatalog, tokenize } from "./catalog.js";

const SOURCES = {
  presets: {
    google_ads: {
      campaign_performance: { entityType: "campaign", resource: "campaign", description: "Campaign performance with cost, clicks and conversions." },
      impression_share: { entityType: "campaign", resource: "campaign", description: "Search impression share and lost impression share." }
    },
    ga4: {
      engagement_overview: { entityType: "event", description: "Engagement rate, bounce rate and average engagement time." }
    },
    search_console: {
      branded_vs_non_branded: { entityType: "query_segment", dimensions: ["query"], description: "Branded or non-branded query performance." }
    },
    callrail: {
      calls_by_source: { entityType: "call", description: "Phone calls grouped by source." }
    }
  },
  normalizedSchema: {
    standardDimensions: ["date", "campaign_name", "device"],
    standardMetrics: ["clicks", "cost", "bounce_rate"],
    crossSourceMappings: {
      cost: {
        google_ads: ["metrics.cost_micros"],
        ga4: ["advertiserAdCost"],
        search_console: [],
        meta: ["spend"]
      }
    }
  },
  guardrails: {
    google_ads: {
      limitations: [
        "Auction Insights is not exposed by the Google Ads API at all; no tool here can return it.",
        "Quality Score is a current attribute, not a historical series."
      ]
    }
  },
  tools: [
    { name: "query_google_ads", platform: "google_ads" },
    { name: "bing_webmaster_queries", platform: "bing_webmaster" }
  ]
};

const catalog = buildMarketingCatalog(SOURCES);
const find = (query, options = {}) => searchCatalog(catalog, { query, limit: 10, ...options });

test("the catalog indexes presets, fields and tools across platforms", () => {
  assert.ok(catalog.entryCount > 10);
  const kinds = new Set(catalog.entries.map((item) => item.kind));
  assert.deepEqual([...kinds].sort(), ["field", "preset", "tool"]);
  assert.ok(catalog.platforms.includes("google_ads"));
  assert.ok(catalog.platforms.includes("callrail"));
});

test("every preset carries a ready-to-run call with the right tool and id argument", () => {
  for (const item of catalog.entries.filter((entry) => entry.kind === "preset")) {
    const serving = PLATFORM_PRESET_TOOLS[item.platform];
    assert.ok(item.call, `${item.id} has no call`);
    assert.equal(item.call.tool, serving.tool);
    assert.equal(item.call.arguments.preset, item.id);
    assert.ok(serving.idArg in item.call.arguments, `${item.id} does not name its id argument`);
  }
});

test("plain-language questions reach the right platform", () => {
  assert.equal(find("phone calls").matches[0].platform, "callrail");
  assert.equal(find("branded queries").matches[0].id, "branded_vs_non_branded");
  assert.ok(find("bounce rate").matches.some((match) => match.id === "bounce_rate" || match.id === "engagement_overview"));
});

test("synonyms map everyday words onto the API vocabulary", () => {
  // "spend" is not the field name anywhere, but it should still find cost.
  const spend = find("how much did we spend");
  assert.ok(spend.matches.some((match) => match.id === "cost"), "spend did not reach cost");
  assert.ok(expandQuery("spend").expanded.includes("cost"));
});

test("a field match shows the native name on every platform that has it", () => {
  const cost = find("cost").matches.find((match) => match.id === "cost");
  assert.deepEqual(cost.nativeFields.google_ads, ["metrics.cost_micros"]);
  assert.deepEqual(cost.nativeFields.meta, ["spend"]);
  // And is explicit about where it does not exist.
  assert.ok(cost.notAvailableOn.includes("search_console"));
});

test("something no API exposes is reported as unavailable, not silently missing", () => {
  const result = find("auction insights");
  assert.ok(result.notAvailable?.length, "auction insights should be flagged as unavailable");
  assert.match(result.notAvailable[0].limitation, /not exposed by the Google Ads API/);
});

test("a guardrail that is a caveat rather than an absence is not reported as unavailable", () => {
  // "Quality Score is a current attribute" is a limitation but not an absence.
  assert.ok(!catalog.unavailable.some((item) => /Quality Score/.test(item.limitation)));
});

test("results can be narrowed by platform and by kind", () => {
  const onlyAds = find("campaign", { platform: "google_ads" });
  assert.ok(onlyAds.matches.length);
  assert.ok(onlyAds.matches.every((match) =>
    (Array.isArray(match.platform) ? match.platform : [match.platform]).includes("google_ads")));

  const onlyPresets = find("campaign", { kind: "preset" });
  assert.ok(onlyPresets.matches.every((match) => match.kind === "preset"));
});

test("an exact id outranks a passing mention", () => {
  assert.equal(find("impression_share").matches[0].id, "impression_share");
});

test("an empty or unmatched query explains what to do instead", () => {
  assert.match(searchCatalog(catalog, { query: "   " }).note, /Give a query/);
  const nothing = find("zzzz nonexistent capability");
  assert.equal(nothing.matchCount, 0);
  assert.match(nothing.note, /list_marketing_presets/);
});

test("tokenize keeps dotted and underscored field paths whole", () => {
  assert.deepEqual(tokenize("metrics.cost_micros"), ["metrics.cost_micros"]);
});

test("the catalog is built from its sources, so it cannot drift from them", () => {
  // Adding a preset to the source table must show up without touching the catalog code.
  const extended = buildMarketingCatalog({
    ...SOURCES,
    presets: { ...SOURCES.presets, ga4: { ...SOURCES.presets.ga4, brand_new_preset: { entityType: "event", description: "A preset added later." } } }
  });
  assert.ok(searchCatalog(extended, { query: "brand_new_preset" }).matches.some((match) => match.id === "brand_new_preset"));
});
