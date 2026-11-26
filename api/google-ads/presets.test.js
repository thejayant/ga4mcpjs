import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NEW_GOOGLE_ADS_PRESETS, NEW_PRESET_NAMES, NEW_RECOMMENDATION_TYPES,
  assertWithinRetention, buildNewPresetQuery, runBenchmarks,
  runLocalServicesEligibility, runNewPreset
} from "./presets.js";
import { buildReachForecastBody, runReachPlanner } from "./reach.js";
import { assertSelectQuery } from "./gaql.js";

function stub(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: status < 300, status, text: async () => JSON.stringify(payload) };
  };
  return { impl, calls };
}

const context = (impl) => ({ accessToken: "t", fetchImpl: impl });
const params = { customerId: "9529469947", startDate: "2026-10-01", endDate: "2026-10-31" };

/* ---------------- every new preset is a valid read ---------------- */

test("every new preset builds a valid SELECT-only query", () => {
  for (const preset of NEW_PRESET_NAMES) {
    const built = buildNewPresetQuery(preset, params);
    assert.doesNotThrow(() => assertSelectQuery(built.query), `${preset} produced a non-SELECT query`);
    assert.equal(NEW_GOOGLE_ADS_PRESETS[preset].readOnly, true, `${preset} is not marked read-only`);
    assert.match(NEW_GOOGLE_ADS_PRESETS[preset].description, /[Rr]ead-only/, `${preset} description does not say read-only`);
    assert.match(built.query, /LIMIT \d+/, `${preset} has no row limit`);
  }
  assert.equal(NEW_PRESET_NAMES.length, 13);
});

test("no new preset query contains a write verb or pageSize", () => {
  for (const preset of NEW_PRESET_NAMES) {
    const { query } = buildNewPresetQuery(preset, params);
    assert.ok(!/mutate|page_?size/i.test(query), `${preset} query looks unsafe: ${query}`);
  }
});

/* ---------------- item 27: the specific new fields ---------------- */

test("the AI Max preset reads both migration date fields (v25.1)", () => {
  const { query } = buildNewPresetQuery("ai_max_migration", params);
  assert.match(query, /campaign\.aca_migration_date_time/);
  assert.match(query, /campaign\.broad_match_migration_date_time/);
});

test("the enhanced conversions audit reads the v26 replacements, not the removed field", () => {
  const { query } = buildNewPresetQuery("enhanced_conversions_audit", params);
  // v26 removed ConversionTrackingSetting.enhanced_conversions_for_leads_enabled.
  assert.ok(!/enhanced_conversions_for_leads_enabled/.test(query), "the removed v26 field is still selected");
  assert.match(query, /customer\.conversion_tracking_setting\.enablement_setting/);
  assert.match(query, /customer\.conversion_tracking_setting\.effective_enablement_setting/);
});

test("the budgets preset reads budget network settings and the customer defaults (v26.1)", () => {
  assert.match(buildNewPresetQuery("budget_network_settings", params).query, /campaign_budget\.budget_network_settings/);
  assert.match(buildNewPresetQuery("customer_budget_network_settings", params).query, /customer_budget_network_setting\.budget_network_settings/);
});

test("the unique reach preset selects 1+ through 10+ (v26.2)", () => {
  const { query } = buildNewPresetQuery("unique_reach", params);
  for (const metric of ["unique_users", "unique_users_two_plus", "unique_users_five_plus", "unique_users_ten_plus"]) {
    assert.match(query, new RegExp(`metrics\\.${metric}\\b`), `missing metrics.${metric}`);
  }
});

test("Local Services presets cover PMax local services and lead types", () => {
  assert.match(buildNewPresetQuery("local_services_campaigns", params).query, /campaign\.pmax_campaign_settings\.local_services_enabled/);
  const leads = buildNewPresetQuery("local_services_leads", params).query;
  assert.match(leads, /local_services_lead\.lead_type/);
  // ContactDetails.email was removed in v25 and must not be selected.
  assert.ok(!/contact_details\.email/.test(leads), "a field removed in v25 is still selected");
});

test("the lift presets read LiftMeasurementConfig and SearchLiftKeywordBundle", () => {
  assert.match(buildNewPresetQuery("lift_studies", params).query, /FROM lift_measurement_config/);
  assert.match(buildNewPresetQuery("search_lift_keyword_bundles", params).query, /FROM search_lift_keyword_bundle/);
});

test("the recommendations preset is read-only and documents the new types", () => {
  const definition = NEW_GOOGLE_ADS_PRESETS.recommendations_read;
  assert.match(definition.description, /never applies or dismisses/);
  assert.match(buildNewPresetQuery("recommendations_read", params).query, /FROM recommendation/);
  assert.deepEqual(NEW_RECOMMENDATION_TYPES, [
    "RAISE_TARGET_CPA_PERFORMANCE_BID_TOO_LOW",
    "LOWER_TARGET_ROAS_PERFORMANCE_BID_TOO_LOW",
    "RAISE_BUDGET_PERFORMANCE_TOO_LOW",
    "OPTIMIZE_FOR_NEW_CUSTOMERS"
  ]);
});

/* ---------------- item 28: deprecation guards ---------------- */

test("the call-ads guard filters on the real enum value CALL_AD", () => {
  const { query } = buildNewPresetQuery("deprecated_call_only_ads", params);
  // The AdType enum value is CALL_AD; "CALL_ONLY_AD" does not exist and would error.
  assert.match(query, /ad_group_ad\.ad\.type = 'CALL_AD'/);
  assert.match(NEW_GOOGLE_ADS_PRESETS.deprecated_call_only_ads.guidance, /Responsive Search Ad/);
  assert.match(NEW_GOOGLE_ADS_PRESETS.deprecated_call_only_ads.description, /February 2027/);
});

test("the language guard targets Search and Performance Max only", () => {
  const { query } = buildNewPresetQuery("deprecated_language_criteria", params);
  assert.match(query, /campaign_criterion\.type = 'LANGUAGE'/);
  assert.match(query, /IN \('SEARCH', 'PERFORMANCE_MAX'\)/);
});

test("the Smart campaign guard names PMax in text only and never a draft method", () => {
  const definition = NEW_GOOGLE_ADS_PRESETS.deprecated_smart_campaigns;
  assert.match(buildNewPresetQuery("deprecated_smart_campaigns", params).query, /campaign\.advertising_channel_type = 'SMART'/);
  assert.match(definition.guidance, /Performance Max is the migration path/);
  assert.match(definition.guidance, /strictly read-only/);
  // It must not instruct or attempt a draft-generating call.
  assert.ok(!/GeneratePMaxDraftCampaign\(/.test(definition.guidance));
  assert.match(definition.guidance, /will not create a draft campaign/);
});

test("data retention: an out-of-range date range is rejected with a clear error", () => {
  const today = new Date("2026-11-26T00:00:00Z");
  assert.throws(
    () => assertWithinRetention({ startDate: "2020-01-01", endDate: "2020-03-01", today }),
    (error) => {
      assert.equal(error.code, "INVALID_DATE_RANGE");
      assert.match(error.message, /37 months/);
      assert.match(error.message, /empty result rather than an error/);
      return true;
    }
  );
});

test("data retention: in-range ranges pass, and high-level data gets 11 years", () => {
  const today = new Date("2026-11-26T00:00:00Z");
  assert.equal(assertWithinRetention({ startDate: "2024-01-01", endDate: "2024-02-01", today }).ok, true);
  // 2020 is outside 37 months but inside 11 years.
  assert.equal(assertWithinRetention({ startDate: "2020-01-01", granularity: "high_level", today }).ok, true);
});

test("data retention: malformed and reversed ranges are rejected", () => {
  assert.throws(() => assertWithinRetention({ startDate: "not-a-date" }), /not a date/);
  assert.throws(() => assertWithinRetention({ startDate: "2026-05-01", endDate: "2026-01-01" }), /before startDate/);
});

test("a time-series preset validates its date range", () => {
  assert.throws(() => buildNewPresetQuery("unique_reach", { customerId: "1", startDate: "2019-01-01", endDate: "2019-02-01" }), /37 months/);
});

/* ---------------- "not available" reporting (item 27) ---------------- */

test("every preset reports not-available cleanly when the account has no data", async () => {
  for (const preset of NEW_PRESET_NAMES) {
    const { impl } = stub({ results: [] });
    const result = await runNewPreset({ preset, params, context: context(impl) });
    assert.equal(result.ok, true, `${preset} errored on an empty result`);
    assert.equal(result.available, false, `${preset} did not report available: false`);
    assert.equal(result.rowCount, 0);
    assert.ok(result.message && result.message.length > 20, `${preset} has no readable empty message`);
  }
});

test("lift presets say plainly that no study is configured", async () => {
  for (const preset of ["lift_studies", "search_lift_keyword_bundles"]) {
    const { impl } = stub({ results: [] });
    const result = await runNewPreset({ preset, params, context: context(impl) });
    assert.match(result.message, /no (lift study|Search Lift keyword bundle)/i);
  }
});

test("a preset with rows reports available with its guidance", async () => {
  const { impl } = stub({ results: [{ campaign: { id: "1", name: "Call campaign" }, adGroupAd: { ad: { id: "9", type: "CALL_AD" } } }] });
  const result = await runNewPreset({ preset: "deprecated_call_only_ads", params, context: context(impl) });
  assert.equal(result.available, true);
  assert.equal(result.rowCount, 1);
  assert.match(result.guidance, /Responsive Search Ad/);
  assert.equal(result.googleAds, "read-only");
});

test("a failed preset normalizes the error", async () => {
  const { impl } = stub({ error: { message: "nope", details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] }] } }, { status: 403 });
  const result = await runNewPreset({ preset: "ai_max_migration", params, context: context(impl) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PERMISSION_DENIED");
});

/* ---------------- item 27: benchmarks ---------------- */

test("benchmarks sends the required fields and asks for percentile metrics", async () => {
  const { impl, calls } = stub({ customerMetrics: { percentileMetrics: { clicks: 10 } }, benchmarksMetrics: {} });
  const result = await runBenchmarks(
    { customerId: "9529469947", countryCode: "US", categories: ["/Home & Garden"], products: ["SEARCH"] },
    context(impl)
  );
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  const body = calls[0].body;
  assert.equal(body.customerId, "9529469947");
  assert.deepEqual(body.benchmarksSource, { allAdvertisers: true });
  assert.deepEqual(body.location, { countryCode: "US" });
  assert.ok(body.productFilter, "productFilter is required");
  assert.deepEqual(body.categoryFilter.categories, [{ categoryId: "/Home & Garden" }]);
  assert.deepEqual(body.supplementalData, ["PERCENTILE_METRICS"]);
  assert.ok(result.percentileMetrics);
});

test("benchmarks validates its required inputs", async () => {
  const { impl } = stub({});
  await assert.rejects(() => runBenchmarks({ countryCode: "US", categories: ["x"] }, context(impl)), /needs customerId/);
  await assert.rejects(() => runBenchmarks({ customerId: "1", categories: ["x"] }, context(impl)), /needs a location/);
  await assert.rejects(() => runBenchmarks({ customerId: "1", countryCode: "US" }, context(impl)), /requires at least one category/);
  await assert.rejects(
    () => runBenchmarks({ customerId: "1", countryCode: "US", categories: ["x"], industryVerticalId: "5" }, context(impl)),
    /only be used with the all_advertisers/
  );
});

test("benchmarks reports not-available when Google returns nothing", async () => {
  const { impl } = stub({});
  const result = await runBenchmarks({ customerId: "1", countryCode: "US", categories: ["/Home & Garden"] }, context(impl));
  assert.equal(result.available, false);
  assert.match(result.message, /no benchmark metrics/);
});

/* ---------------- item 27: Local Services eligibility ---------------- */

test("Local Services eligibility returns the goals and lead types", async () => {
  const { impl, calls } = stub({
    eligible: true,
    eligibleGoals: [{ leadType: "PHONE_CALL", categories: [{ categoryId: "xcat:service_area_business_hvac" }] }, { leadType: "COUPON", categories: [] }],
    suggestionReasons: []
  });
  const result = await runLocalServicesEligibility({ customerId: "9529469947", listingId: "12345" }, context(impl));
  assert.equal(result.ok, true);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.leadTypes, ["PHONE_CALL", "COUPON"]);
  assert.deepEqual(calls[0].body, { customerId: "9529469947", listingId: "12345" });
});

test("Local Services eligibility explains an ineligible result", async () => {
  const { impl } = stub({ eligible: false, suggestionReasons: ["MISSING_LICENSE"] });
  const result = await runLocalServicesEligibility({ customerId: "1", listingId: "2" }, context(impl));
  assert.equal(result.eligible, false);
  assert.match(result.message, /not currently eligible/);
  assert.deepEqual(result.suggestionReasons, ["MISSING_LICENSE"]);
});

test("Local Services eligibility needs a listing id", async () => {
  const { impl } = stub({});
  await assert.rejects(() => runLocalServicesEligibility({ customerId: "1" }, context(impl)), /needs listingId/);
});

/* ---------------- reach planner: the v25/v26 shape fix ---------------- */

test("the reach forecast puts the location in targeting.plannableLocationIds", () => {
  const body = buildReachForecastBody({
    customerId: "9529469947", plannableLocationId: "2840",
    products: [{ code: "TRUEVIEW_IN_STREAM", budget: 5000 }]
  });
  // v25 removed Targeting.plannable_location_id; v26 has no top-level one either.
  assert.deepEqual(body.targeting.plannableLocationIds, ["2840"]);
  assert.ok(!("plannableLocationId" in body), "the removed top-level field is still sent");
  assert.ok(!("plannableLocationId" in body.targeting), "the removed targeting field is still sent");
  assert.equal(body.plannedProducts[0].budgetMicros, "5000000000");
});

test("the frequency cap uses the v25 replacement field", () => {
  const body = buildReachForecastBody({
    customerId: "1", plannableLocationIds: ["2840"], cookieFrequencyCap: 3,
    products: [{ code: "X", budget: 10 }]
  });
  assert.deepEqual(body.cookieFrequencyCapSetting, { impressions: 3, timeUnit: "WEEK" });
  assert.ok(!("cookieFrequencyCap" in body), "the field removed in v25 is still sent");
});

test("caller targeting is preserved alongside the location", () => {
  const body = buildReachForecastBody({
    customerId: "1", plannableLocationId: "2840",
    targeting: { ageRange: "AGE_RANGE_25_34", genders: [{ type: "MALE" }], plannableLocationId: "9999" },
    products: [{ code: "X", budget: 10 }]
  });
  assert.equal(body.targeting.ageRange, "AGE_RANGE_25_34");
  // A legacy key inside targeting is dropped in favour of the supported list.
  assert.deepEqual(body.targeting.plannableLocationIds, ["2840"]);
});

test("reach planner validates its inputs", () => {
  assert.throws(() => buildReachForecastBody({ customerId: "1", products: [{ code: "X", budget: 1 }] }), /needs plannableLocationId/);
  assert.throws(() => buildReachForecastBody({ customerId: "1", plannableLocationId: "2840" }), /needs products/);
});

test("reach planner list actions hit the version root and report empty cleanly", async () => {
  const { impl, calls } = stub({ plannableLocations: [] });
  const result = await runReachPlanner({ action: "locations" }, context(impl));
  assert.match(calls[0].url, /\/v\d+:listPlannableLocations$/);
  assert.equal(result.available, false);
  assert.match(result.message, /no plannable locations/);
});

test("reach planner explains an unapproved account", async () => {
  const { impl } = stub({});
  const result = await runReachPlanner({
    action: "forecast", customerId: "1", plannableLocationId: "2840", products: [{ code: "X", budget: 10 }]
  }, context(impl));
  assert.equal(result.available, false);
  assert.match(result.message, /approve an account for Reach Planner/);
});
