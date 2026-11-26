// New read-only Google Ads presets and tools for v25/v26 features (items 27, 28).
//
// Every field, enum and RPC path below was checked against the v26 reference. All of these
// are reads: the GAQL presets go through GoogleAdsService.Search, and the two non-GAQL tools
// (benchmarks, Local Services eligibility) are allowlisted read RPCs.

import { adsRequest, normalizeCustomerId } from "./client.js";
import { withGaqlLimit } from "./gaql.js";

/* ---------------- item 28: data retention guard ---------------- */

// Granular reporting data (daily, hourly, weekly) is kept for 37 months as of 2026-06-01.
// High-level data (monthly, quarterly, yearly) stays available for 11 years.
export const GRANULAR_RETENTION_MONTHS = 37;

function monthsBetween(from, to) {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

/**
 * Rejects a date range that reaches past Google's retention window, instead of letting the
 * query come back mysteriously empty (item 28).
 *
 * @param {{startDate:string, endDate:string, granularity?:"granular"|"high_level"}} range
 */
export function assertWithinRetention({ startDate, endDate, granularity = "granular", today = new Date() } = {}) {
  if (!startDate) return { ok: true };
  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) {
    throw retentionError(`startDate "${startDate}" is not a date in YYYY-MM-DD form.`);
  }
  const limitMonths = granularity === "high_level" ? 11 * 12 : GRANULAR_RETENTION_MONTHS;
  const age = monthsBetween(start, today);
  if (age > limitMonths) {
    const earliest = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - limitMonths, today.getUTCDate()));
    throw retentionError(
      `startDate ${startDate} is ${age} months old, but Google keeps ${granularity === "high_level" ? "high-level (monthly, quarterly, yearly)" : "granular (daily, hourly, weekly)"} reporting data for only ${limitMonths} months. ` +
      `The earliest date that can return data is ${earliest.toISOString().slice(0, 10)}. ` +
      "Google answers an out-of-range request with an empty result rather than an error, so this is rejected here to avoid a silently blank report."
    );
  }
  if (endDate) {
    const end = new Date(`${endDate}T00:00:00Z`);
    if (Number.isNaN(end.getTime())) throw retentionError(`endDate "${endDate}" is not a date in YYYY-MM-DD form.`);
    if (end < start) throw retentionError(`endDate ${endDate} is before startDate ${startDate}.`);
  }
  return { ok: true, ageMonths: age, limitMonths };
}

function retentionError(message) {
  const error = new Error(message);
  error.code = "INVALID_DATE_RANGE";
  return error;
}

/* ---------------- item 27: new GAQL presets ---------------- */

// Unique reach metrics 1+ to 10+ (v26.2 extended these to the customer resource and added
// ad format / network segmentation).
export const UNIQUE_REACH_METRICS = [
  "metrics.unique_users",
  "metrics.unique_users_two_plus", "metrics.unique_users_three_plus", "metrics.unique_users_four_plus",
  "metrics.unique_users_five_plus", "metrics.unique_users_six_plus", "metrics.unique_users_seven_plus",
  "metrics.unique_users_eight_plus", "metrics.unique_users_nine_plus", "metrics.unique_users_ten_plus"
].join(", ");

// Recommendation types added since v25, read-only. Nothing here applies or dismisses.
export const NEW_RECOMMENDATION_TYPES = Object.freeze([
  "RAISE_TARGET_CPA_PERFORMANCE_BID_TOO_LOW",   // v25.2
  "LOWER_TARGET_ROAS_PERFORMANCE_BID_TOO_LOW",  // v25.2
  "RAISE_BUDGET_PERFORMANCE_TOO_LOW",           // v26
  "OPTIMIZE_FOR_NEW_CUSTOMERS"                  // v26.1
]);

export const NEW_GOOGLE_ADS_PRESETS = Object.freeze({
  ai_max_migration: {
    entityType: "campaign",
    resource: "campaign",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only. Which campaigns Google will auto-migrate to AI Max for Search, and when. " +
      "campaign.aca_migration_date_time and campaign.broad_match_migration_date_time (v25.1) are set by Google on campaigns scheduled for migration; a null value means this campaign is not scheduled.",
    query: () =>
      "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, " +
      "campaign.aca_migration_date_time, campaign.broad_match_migration_date_time " +
      "FROM campaign WHERE campaign.status != 'REMOVED'"
  },

  recommendations_read: {
    entityType: "recommendation",
    resource: "recommendation",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only recommendations, including the types added since v25: raise target CPA and lower target ROAS (v25.2), " +
      "raise budget for Search (v26) and optimize for new customers (v26.1). This never applies or dismisses anything.",
    query: () =>
      "SELECT recommendation.resource_name, recommendation.type, recommendation.campaign, recommendation.dismissed, " +
      "recommendation.impact.base_metrics.impressions, recommendation.impact.base_metrics.clicks, " +
      "recommendation.impact.base_metrics.cost_micros, recommendation.impact.base_metrics.conversions, " +
      "recommendation.impact.potential_metrics.impressions, recommendation.impact.potential_metrics.clicks, " +
      "recommendation.impact.potential_metrics.cost_micros, recommendation.impact.potential_metrics.conversions " +
      "FROM recommendation"
  },

  enhanced_conversions_audit: {
    entityType: "account",
    resource: "customer",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only. Account-level conversion tracking and Enhanced Conversions configuration. " +
      "v26 removed ConversionTrackingSetting.enhanced_conversions_for_leads_enabled; this reads its replacements, " +
      "enablement_setting and effective_enablement_setting, on customer.conversion_tracking_setting.",
    query: () =>
      "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, " +
      "customer.conversion_tracking_setting.conversion_tracking_id, " +
      "customer.conversion_tracking_setting.conversion_tracking_status, " +
      "customer.conversion_tracking_setting.cross_account_conversion_tracking_id, " +
      "customer.conversion_tracking_setting.google_ads_conversion_customer, " +
      "customer.conversion_tracking_setting.enablement_setting, " +
      "customer.conversion_tracking_setting.effective_enablement_setting " +
      "FROM customer"
  },

  budget_network_settings: {
    entityType: "budget",
    resource: "campaign_budget",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only. Campaign budgets with their per-channel network settings " +
      "(CampaignBudget.budget_network_settings, v26.1). A budget with this unset inherits the " +
      "customer-level defaults, which the customer_budget_network_settings preset reads.",
    query: () =>
      "SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, " +
      "campaign_budget.total_amount_micros, campaign_budget.delivery_method, campaign_budget.explicitly_shared, " +
      "campaign_budget.period, campaign_budget.status, campaign_budget.budget_network_settings, " +
      "customer.currency_code FROM campaign_budget WHERE campaign_budget.status != 'REMOVED'"
  },

  customer_budget_network_settings: {
    entityType: "account",
    resource: "customer_budget_network_setting",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only. The customer-level budget network defaults (v26.1) that apply to every campaign " +
      "budget whose own budget_network_settings is unset.",
    query: () =>
      "SELECT customer_budget_network_setting.resource_name, customer_budget_network_setting.budget_network_settings " +
      "FROM customer_budget_network_setting"
  },

  local_services_campaigns: {
    entityType: "campaign",
    resource: "campaign",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only. Local Services campaigns and the Performance Max campaigns running Local Services " +
      "inventory (Campaign.PmaxCampaignSettings.local_services_enabled, v26).",
    query: () =>
      "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, " +
      "campaign.advertising_channel_sub_type, campaign.pmax_campaign_settings.local_services_enabled " +
      "FROM campaign WHERE campaign.status != 'REMOVED'"
  },

  local_services_leads: {
    entityType: "lead",
    resource: "local_services_lead",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only. Local Services leads with their type -- phone, message, booking and COUPON (added v26.1) -- " +
      "status, service category and whether the advertiser was charged. " +
      "ContactDetails.email was removed in v25 and is deliberately not selected.",
    query: () =>
      "SELECT local_services_lead.id, local_services_lead.lead_type, local_services_lead.lead_status, " +
      "local_services_lead.category_id, local_services_lead.service_id, local_services_lead.contact_details.phone_number, " +
      "local_services_lead.lead_charged, local_services_lead.creation_date_time, local_services_lead.campaign, " +
      "local_services_lead.locale, local_services_lead.credit_details.credit_state " +
      "FROM local_services_lead"
  },

  lift_studies: {
    entityType: "lift_study",
    resource: "lift_measurement_config",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only. Brand and Conversion Lift studies configured on the account (LiftMeasurementConfig, v25.1), " +
      "with the campaigns and conversion actions each is linked to.",
    emptyMessage:
      "No lift study is configured on this account. Brand, Conversion and Search Lift studies are set up by a " +
      "Google representative, so there is nothing to report until one exists.",
    query: () =>
      "SELECT lift_measurement_config.resource_name, lift_measurement_config.lift_measurement_config_id, " +
      "lift_measurement_config.name, lift_measurement_config.campaigns, " +
      "lift_measurement_config.conversion_actions, " +
      "lift_measurement_config.conversion_lift_holdback_ratio_micros, " +
      "lift_measurement_config.survey_language FROM lift_measurement_config"
  },

  search_lift_keyword_bundles: {
    entityType: "lift_study",
    resource: "search_lift_keyword_bundle",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only. Search Lift keyword bundles (SearchLiftKeywordBundle, v26) with their status and source.",
    emptyMessage:
      "No Search Lift keyword bundle exists on this account, so no Search Lift study is configured. " +
      "Search Lift studies are set up by a Google representative.",
    query: () =>
      "SELECT search_lift_keyword_bundle.resource_name, search_lift_keyword_bundle.search_lift_keyword_bundle_id, " +
      "search_lift_keyword_bundle.status, search_lift_keyword_bundle.source, search_lift_keyword_bundle.keywords " +
      "FROM search_lift_keyword_bundle"
  },

  unique_reach: {
    entityType: "campaign",
    resource: "campaign",
    timeSeries: true,
    readOnly: true,
    description:
      "Read-only. Unique reach at effective frequency 1+ through 10+ for video and Demand Gen campaigns " +
      "(v26.2 extended these metrics and their ad format / network segmentation).",
    query: ({ startDate, endDate }) =>
      `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, ${UNIQUE_REACH_METRICS} ` +
      `FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`
  },

  /* ---------------- item 28: deprecation guards ---------------- */

  deprecated_call_only_ads: {
    entityType: "ad",
    resource: "ad_group_ad",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only deprecation audit. Call ads (CallAdInfo, ad type CALL_AD): new ones could not be created from " +
      "January 2026 and existing ones stop serving in February 2027. Migrate to Responsive Search Ads with call assets.",
    emptyMessage: "No call ads found on this account, so there is nothing to migrate before the February 2027 cutoff.",
    guidance:
      "Each ad listed here stops serving in February 2027. Replace it with a Responsive Search Ad plus a call asset, " +
      "which keeps the call extension while staying on a supported ad type. This server is read-only and will not make that change.",
    query: () =>
      "SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, " +
      "ad_group_ad.status, ad_group_ad.ad.call_ad.phone_number, ad_group_ad.ad.call_ad.business_name " +
      "FROM ad_group_ad WHERE ad_group_ad.ad.type = 'CALL_AD' AND ad_group_ad.status != 'REMOVED'"
  },

  deprecated_language_criteria: {
    entityType: "campaign",
    resource: "campaign_criterion",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only deprecation audit. Manual language targeting (CampaignCriterion.language) has been unsupported " +
      "since September 2026 on Search, AI Max for Search and Performance Max ads on Google Search. Existing criteria " +
      "are still returned by queries, so they can be audited here; adding or updating one now fails with " +
      "ContextError.OPERATION_NOT_PERMITTED_FOR_CONTEXT.",
    emptyMessage: "No manual language criteria on Search or Performance Max campaigns.",
    guidance:
      "Google now matches ads to users by the language of the creatives and landing pages. These criteria no longer " +
      "shape targeting on Search / AI Max / PMax and should be removed in the Google Ads UI. This server is read-only " +
      "and will not remove them.",
    query: () =>
      "SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign_criterion.criterion_id, " +
      "campaign_criterion.type, campaign_criterion.language.language_constant, campaign_criterion.negative, " +
      "campaign_criterion.status FROM campaign_criterion " +
      "WHERE campaign_criterion.type = 'LANGUAGE' AND campaign_criterion.status != 'REMOVED' " +
      "AND campaign.advertising_channel_type IN ('SEARCH', 'PERFORMANCE_MAX')"
  },

  deprecated_smart_campaigns: {
    entityType: "campaign",
    resource: "campaign",
    timeSeries: false,
    readOnly: true,
    description:
      "Read-only deprecation audit. New Smart campaigns could not be created from 23 September 2026. " +
      "Existing ones keep serving and can still be edited in the Google Ads UI.",
    emptyMessage: "No Smart campaigns on this account.",
    guidance:
      "Performance Max is the migration path for Smart campaigns. That migration is a write operation and this server " +
      "is strictly read-only: it will not create a draft campaign or call GeneratePMaxDraftCampaign. Do it in the " +
      "Google Ads UI, or with a tool that is authorised to write.",
    query: () =>
      "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, " +
      "campaign.advertising_channel_sub_type, campaign.start_date " +
      "FROM campaign WHERE campaign.advertising_channel_type = 'SMART' AND campaign.status != 'REMOVED'"
  }
});

export const NEW_PRESET_NAMES = Object.keys(NEW_GOOGLE_ADS_PRESETS);

/**
 * Builds the GAQL for one new preset.
 * Time-series presets validate their date range against Google's retention window (item 28).
 */
export function buildNewPresetQuery(preset, params = {}) {
  const definition = NEW_GOOGLE_ADS_PRESETS[preset];
  if (!definition) throw new Error(`Unknown Google Ads preset: ${preset}`);
  if (definition.timeSeries) {
    assertWithinRetention({ startDate: params.startDate, endDate: params.endDate, granularity: "granular" });
  }
  const query = withGaqlLimit(definition.query(params), params.limit || 500);
  return { preset, query, ...definition, query: query };
}

/**
 * Runs a new preset and shapes the result, reporting "not available" cleanly when the
 * account simply has no such data (item 27).
 */
export async function runNewPreset({ preset, params = {}, context }) {
  const definition = NEW_GOOGLE_ADS_PRESETS[preset];
  if (!definition) throw new Error(`Unknown Google Ads preset: ${preset}`);
  const built = buildNewPresetQuery(preset, params);

  const response = await adsRequest({
    path: `customers/${normalizeCustomerId(params.customerId)}/googleAds:search`,
    accessToken: context.accessToken,
    body: { query: built.query },
    customerId: params.customerId,
    loginCustomerId: params.loginCustomerId,
    directoryEntry: context.directoryEntry,
    managerIds: context.managerIds || [],
    fetchImpl: context.fetchImpl,
    store: context.store,
    debug: params.debug
  });

  const base = {
    preset,
    googleAds: "read-only",
    entityType: definition.entityType,
    resource: definition.resource,
    gaql: built.query,
    quota: response.quota,
    attempts: response.attempts
  };

  if (!response.ok) {
    return { ...base, ok: false, available: false, error: response.error };
  }

  const rows = response.body?.results || [];
  if (!rows.length) {
    return {
      ...base,
      ok: true,
      available: false,
      rowCount: 0,
      rows: [],
      // A clean "nothing configured / nothing found" rather than a bare empty array.
      message: definition.emptyMessage || `No ${definition.resource} rows on this account for this request.`
    };
  }

  return {
    ...base,
    ok: true,
    available: true,
    rowCount: rows.length,
    rows,
    ...(definition.guidance ? { guidance: definition.guidance } : {}),
    nextPageToken: response.body?.nextPageToken || null
  };
}

/* ---------------- item 27: BenchmarksService ---------------- */

/**
 * Industry benchmark metrics (BenchmarksService.GenerateBenchmarksMetrics).
 *
 * benchmarks_source, location and product_filter are all required by the API. Percentile
 * metrics (v25.2) arrive on CustomerMetrics.percentile_metrics and have to be asked for via
 * supplemental_data; category_filter is only valid with the all_advertisers source.
 */
export async function runBenchmarks(params, context) {
  const customerId = normalizeCustomerId(params.customerId);
  if (!customerId) throw new Error("google_ads_benchmarks needs customerId (a client account, not a manager).");
  if (!params.countryCode && !params.geoTargetConstant) {
    throw new Error("google_ads_benchmarks needs a location: pass countryCode (for example US) or geoTargetConstant.");
  }

  const useAllAdvertisers = params.categories?.length ? true : params.benchmarksSource !== "industry_vertical";
  if (params.categories?.length && params.industryVerticalId) {
    throw new Error("categories can only be used with the all_advertisers benchmarks source, so do not also pass industryVerticalId.");
  }
  if (!useAllAdvertisers && !params.industryVerticalId) {
    throw new Error("The industry_vertical benchmarks source needs industryVerticalId.");
  }
  if (useAllAdvertisers && !params.categories?.length) {
    throw new Error("The all_advertisers benchmarks source requires at least one category (categories), for example \"/Home & Garden\".");
  }

  const body = {
    customerId,
    benchmarksSource: useAllAdvertisers
      ? { allAdvertisers: true }
      : { industryVerticalId: String(params.industryVerticalId) },
    location: params.geoTargetConstant
      ? { geoTargetConstant: String(params.geoTargetConstant) }
      : { geoTargetConstant: `geoTargetConstants/${String(params.countryCode).replace(/\D/g, "") || ""}` },
    productFilter: params.marketingObjectives?.length
      ? { marketingObjectiveList: { marketingObjectives: params.marketingObjectives } }
      : { productList: { products: params.products || [] } },
    ...(params.categories?.length ? { categoryFilter: { categories: params.categories.map((id) => ({ categoryId: String(id) })) } } : {}),
    ...(params.currencyCode ? { currencyCode: params.currencyCode } : {}),
    ...(params.startDate && params.endDate ? { dateRange: { startDate: params.startDate, endDate: params.endDate } } : {}),
    ...(params.breakdown?.length ? { breakdownDefinition: { dimensions: params.breakdown } } : {}),
    // Percentile metrics are supplemental: without this the response holds core data only.
    ...(params.includePercentiles === false ? {} : { supplementalData: ["PERCENTILE_METRICS"] })
  };

  // A country code was given as a plain country, not a geo target constant.
  if (!params.geoTargetConstant && !/\d/.test(String(params.countryCode))) {
    body.location = { countryCode: String(params.countryCode).toUpperCase() };
  }

  const response = await adsRequest({
    path: `customers/${customerId}:generateBenchmarksMetrics`,
    accessToken: context.accessToken,
    body,
    customerId,
    loginCustomerId: params.loginCustomerId,
    directoryEntry: context.directoryEntry,
    managerIds: context.managerIds || [],
    fetchImpl: context.fetchImpl,
    store: context.store,
    debug: params.debug
  });

  const base = { googleAds: "read-only", request: body, quota: response.quota, attempts: response.attempts };
  if (!response.ok) return { ...base, ok: false, available: false, error: response.error };

  const customerMetrics = response.body?.customerMetrics || null;
  const benchmarks = response.body?.benchmarksMetrics || response.body?.breakdownMetrics || null;
  if (!customerMetrics && !benchmarks) {
    return {
      ...base, ok: true, available: false,
      message: "Google returned no benchmark metrics for this account, category and period. Benchmarks need enough " +
        "advertisers in the chosen category and location, and the account needs direct ad spend in the period " +
        "(a manager account has none of its own)."
    };
  }
  return {
    ...base, ok: true, available: true,
    customerMetrics,
    benchmarksMetrics: benchmarks,
    percentileMetrics: customerMetrics?.percentileMetrics || null,
    note: customerMetrics?.percentileMetrics
      ? undefined
      : "Percentile metrics (v25.2) are returned only when the request asks for them and the category and location have enough advertisers to compare against."
  };
}

/* ---------------- item 27: LocalServicesEligibilityService (v26.1) ---------------- */

/** Local Services eligibility for a customer and Google Business Profile listing. */
export async function runLocalServicesEligibility(params, context) {
  const customerId = normalizeCustomerId(params.customerId);
  if (!customerId) throw new Error("google_ads_local_services_eligibility needs customerId.");
  if (!params.listingId) {
    throw new Error("google_ads_local_services_eligibility needs listingId, the Google Business Profile listing to check.");
  }

  const response = await adsRequest({
    path: `customers/${customerId}:checkLocalServicesEligibility`,
    accessToken: context.accessToken,
    body: { customerId, listingId: String(params.listingId) },
    customerId,
    loginCustomerId: params.loginCustomerId,
    directoryEntry: context.directoryEntry,
    managerIds: context.managerIds || [],
    fetchImpl: context.fetchImpl,
    store: context.store,
    debug: params.debug
  });

  const base = { googleAds: "read-only", customerId, listingId: String(params.listingId), quota: response.quota, attempts: response.attempts };
  if (!response.ok) return { ...base, ok: false, available: false, error: response.error };

  const body = response.body || {};
  const eligibleGoals = body.eligibleGoals || [];
  return {
    ...base,
    ok: true,
    available: true,
    eligible: body.eligible === true,
    eligibleGoals,
    // EligibleGoal.lead_type maps each eligible lead type to its service categories.
    leadTypes: [...new Set(eligibleGoals.map((goal) => goal.leadType).filter(Boolean))],
    suggestionReasons: body.suggestionReasons || [],
    message: body.eligible === true
      ? undefined
      : "This customer and listing are not currently eligible for Local Services. suggestionReasons explains why (licensing, background check, category or location)."
  };
}
