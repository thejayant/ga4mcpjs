import crypto from "node:crypto";
import express from "express";
import { google } from "googleapis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const MERCHANT_CENTER_SCOPE = "https://www.googleapis.com/auth/content";
const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
// Requested purely so the callback can read which account is connecting. Without an
// identity scope Google returns no email and the allowlist has nothing to check.
const OPENID_SCOPE = "openid";
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const GOOGLE_SCOPES = [SEARCH_CONSOLE_SCOPE, GA4_SCOPE, MERCHANT_CENTER_SCOPE, GOOGLE_ADS_SCOPE, OPENID_SCOPE, EMAIL_SCOPE];
// Meta permissions. All of these require App Review before anyone outside the app's own
// admins, developers and testers can grant them.
const META_ADS_SCOPE = "ads_read";
const META_BUSINESS_SCOPE = "business_management";
const META_PAGES_LIST_SCOPE = "pages_show_list";
const META_PAGES_READ_SCOPE = "pages_read_engagement";
const META_INSIGHTS_SCOPE = "read_insights";
const META_INSTAGRAM_SCOPE = "instagram_basic";
const META_INSTAGRAM_INSIGHTS_SCOPE = "instagram_manage_insights";
const META_SCOPES = [
  META_ADS_SCOPE,
  META_BUSINESS_SCOPE,
  META_PAGES_LIST_SCOPE,
  META_PAGES_READ_SCOPE,
  META_INSIGHTS_SCOPE,
  META_INSTAGRAM_SCOPE,
  META_INSTAGRAM_INSIGHTS_SCOPE
];
// CallRail authenticates with a per-user API key rather than OAuth, so there is no
// real scope to grant. This pseudo-scope lets CallRail tools use the same
// TOOL_SCOPE_MAP gate as every other provider: it is present only when the session
// actually carries a CallRail key.
const CALLRAIL_SCOPE = "callrail:read";
const CALLRAIL_SCOPES = [CALLRAIL_SCOPE];
const ALL_KNOWN_SCOPES = [...GOOGLE_SCOPES, ...META_SCOPES, ...CALLRAIL_SCOPES];
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const CLIENT_REGISTRATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const EXPERT_VERSION = "2026.03.14";
const TOOL_SCOPE_MAP = {
  list_search_console_sites: [SEARCH_CONSOLE_SCOPE],
  query_search_console: [SEARCH_CONSOLE_SCOPE],
  list_ga4_properties: [GA4_SCOPE],
  run_ga4_report: [GA4_SCOPE],
  get_ga4_metadata: [GA4_SCOPE],
  check_ga4_compatibility: [GA4_SCOPE],
  batch_run_ga4_reports: [GA4_SCOPE],
  run_ga4_realtime_report: [GA4_SCOPE],
  run_ga4_pivot_report: [GA4_SCOPE],
  list_merchant_accounts: [MERCHANT_CENTER_SCOPE],
  get_merchant_account: [MERCHANT_CENTER_SCOPE],
  list_merchant_products: [MERCHANT_CENTER_SCOPE],
  get_merchant_product: [MERCHANT_CENTER_SCOPE],
  search_merchant_reports: [MERCHANT_CENTER_SCOPE],
  list_merchant_subaccounts: [MERCHANT_CENTER_SCOPE],
  get_merchant_account_issues: [MERCHANT_CENTER_SCOPE],
  get_merchant_product_status_summary: [MERCHANT_CENTER_SCOPE],
  list_merchant_data_sources: [MERCHANT_CENTER_SCOPE],
  run_merchant_preset: [MERCHANT_CENTER_SCOPE],
  get_merchant_developer_registration: [MERCHANT_CENTER_SCOPE],
  register_merchant_developer: [MERCHANT_CENTER_SCOPE],
  list_search_console_sitemaps: [SEARCH_CONSOLE_SCOPE],
  get_search_console_sitemap: [SEARCH_CONSOLE_SCOPE],
  inspect_search_console_url: [SEARCH_CONSOLE_SCOPE],
  list_google_ads_accessible_customers: [GOOGLE_ADS_SCOPE],
  query_google_ads: [GOOGLE_ADS_SCOPE],
  search_stream_google_ads: [GOOGLE_ADS_SCOPE],
  get_google_ads_field: [GOOGLE_ADS_SCOPE],
  search_google_ads_fields: [GOOGLE_ADS_SCOPE],
  run_google_ads_preset: [GOOGLE_ADS_SCOPE],
  list_google_ads_customer_clients: [GOOGLE_ADS_SCOPE],
  run_ga4_preset: [GA4_SCOPE],
  run_ga4_funnel_report: [GA4_SCOPE],
  run_ga4_cohort_report: [GA4_SCOPE],
  list_ga4_custom_definitions: [GA4_SCOPE],
  list_ga4_key_events: [GA4_SCOPE],
  list_ga4_data_streams: [GA4_SCOPE],
  run_search_console_preset: [SEARCH_CONSOLE_SCOPE],
  compare_search_console_periods: [SEARCH_CONSOLE_SCOPE],
  list_meta_ad_accounts: [META_ADS_SCOPE],
  list_meta_pages: [META_PAGES_LIST_SCOPE],
  list_meta_instagram_accounts: [META_INSTAGRAM_SCOPE],
  get_meta_token_info: [META_ADS_SCOPE],
  query_meta_graph: [META_ADS_SCOPE],
  run_meta_preset: [META_ADS_SCOPE]
};
const CALLRAIL_TOOL_SCOPES = {
  list_callrail_accounts: [CALLRAIL_SCOPE],
  list_callrail_companies: [CALLRAIL_SCOPE],
  list_callrail_calls: [CALLRAIL_SCOPE],
  get_callrail_call: [CALLRAIL_SCOPE],
  get_callrail_call_summary: [CALLRAIL_SCOPE],
  get_callrail_call_timeseries: [CALLRAIL_SCOPE],
  list_callrail_trackers: [CALLRAIL_SCOPE],
  get_callrail_resource: [CALLRAIL_SCOPE],
  run_callrail_preset: [CALLRAIL_SCOPE],
  get_callrail_connection: [CALLRAIL_SCOPE]
};
const CALLRAIL_TOOL_NAMES = [
  "list_callrail_accounts",
  "list_callrail_companies",
  "list_callrail_calls",
  "get_callrail_call",
  "get_callrail_call_summary",
  "get_callrail_call_timeseries",
  "list_callrail_trackers",
  "get_callrail_resource",
  "run_callrail_preset",
  "get_callrail_connection"
];
const EXPERT_TOOL_NAMES = [
  "list_marketing_presets",
  "get_marketing_schema",
  "list_marketing_guardrails",
  "normalize_marketing_records"
];
const GOOGLE_ADS_CORE_METRICS = "metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value";
const GOOGLE_ADS_EXTENDED_METRICS = `${GOOGLE_ADS_CORE_METRICS}, metrics.average_cpm, metrics.interactions, metrics.interaction_rate, metrics.conversions_from_interactions_rate, metrics.cost_per_conversion, metrics.value_per_conversion, metrics.all_conversions, metrics.all_conversions_value`;
const GOOGLE_ADS_IMPRESSION_SHARE_METRICS = "metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share, metrics.search_top_impression_share, metrics.search_absolute_top_impression_share, metrics.absolute_top_impression_percentage, metrics.top_impression_percentage";
const GOOGLE_ADS_QUALITY_SCORE_FIELDS = "ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score, ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr";
const GOOGLE_ADS_CONVERSION_ONLY_METRICS = "metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value";
const GOOGLE_ADS_PRESET_DEFINITIONS = {
  campaign_performance: {
    entityType: "campaign",
    resource: "campaign",
    timeSeries: true,
    supportsImpressionShare: true,
    description: "Campaign performance with delivery, cost, click, conversion, and channel fields. Set includeImpressionShare for search IS and lost-IS metrics."
  },
  ad_group_performance: {
    entityType: "ad_group",
    resource: "ad_group",
    timeSeries: true,
    supportsImpressionShare: true,
    description: "Ad group performance with campaign context and spend/conversion metrics."
  },
  keyword_performance: {
    entityType: "keyword",
    resource: "keyword_view",
    timeSeries: true,
    supportsImpressionShare: true,
    supportsQualityScore: true,
    description: "Keyword performance with campaign, ad group, text, match type, and conversion metrics. Set includeQualityScore for Quality Score components."
  },
  search_terms: {
    entityType: "search_term",
    resource: "search_term_view",
    timeSeries: true,
    description: "Search term performance with matched campaign and ad group context."
  },
  asset_performance: {
    entityType: "asset",
    resource: "ad_group_ad_asset_view",
    timeSeries: true,
    description: "Asset-level performance for ads with campaign and ad group context, including performance labels."
  },
  conversions_by_campaign: {
    entityType: "campaign",
    resource: "campaign",
    timeSeries: true,
    description: "Campaign conversion performance focused on conversion counts, value, and cost per conversion."
  },
  ad_performance: {
    entityType: "ad",
    resource: "ad_group_ad",
    timeSeries: true,
    description: "Ad/creative performance including ad type, ad strength, final URLs, and responsive search ad headlines and descriptions."
  },
  impression_share: {
    entityType: "campaign",
    resource: "campaign",
    timeSeries: true,
    description: "Competitive visibility: search impression share, budget-lost IS, rank-lost IS, top and absolute-top share. Auction Insights itself is not exposed by the Google Ads API."
  },
  quality_score: {
    entityType: "keyword",
    resource: "keyword_view",
    timeSeries: false,
    description: "Current Quality Score per keyword with expected CTR, ad relevance, and landing page experience components. Quality Score is a current attribute, not a historical time series."
  },
  shopping_performance: {
    entityType: "product",
    resource: "shopping_performance_view",
    timeSeries: true,
    description: "Shopping ad performance segmented by product item id, title, brand, product type, condition, and channel."
  },
  product_group_performance: {
    entityType: "product_group",
    resource: "product_group_view",
    timeSeries: true,
    description: "Shopping product group (listing group) performance with bids and partition type."
  },
  pmax_asset_groups: {
    entityType: "asset_group",
    resource: "asset_group",
    timeSeries: true,
    description: "Performance Max asset group performance with ad strength and status."
  },
  pmax_search_terms: {
    entityType: "search_term",
    resource: "campaign_search_term_insight",
    timeSeries: true,
    requiresCampaignId: true,
    description: "Performance Max / Search search term insight categories. Requires campaignId. Cost is not exposed for this resource."
  },
  geo_performance: {
    entityType: "geo",
    resource: "geographic_view",
    timeSeries: true,
    description: "Geographic performance by country, region, and city criteria with location type."
  },
  device_performance: {
    entityType: "device",
    resource: "campaign",
    timeSeries: true,
    description: "Campaign performance split by device for bid adjustment decisions."
  },
  ad_schedule_performance: {
    entityType: "ad_schedule",
    resource: "campaign",
    timeSeries: true,
    description: "Campaign performance split by day of week and hour of day for ad schedule decisions."
  },
  demographics_age: {
    entityType: "age_range",
    resource: "age_range_view",
    timeSeries: true,
    description: "Age range performance with campaign and ad group context."
  },
  demographics_gender: {
    entityType: "gender",
    resource: "gender_view",
    timeSeries: true,
    description: "Gender performance with campaign and ad group context."
  },
  audience_performance: {
    entityType: "audience",
    resource: "ad_group_audience_view",
    timeSeries: true,
    description: "Audience segment performance at ad group level with criterion display names."
  },
  placement_performance: {
    entityType: "placement",
    resource: "group_placement_view",
    timeSeries: true,
    description: "Display and video placement performance showing where ads actually served."
  },
  conversion_actions: {
    entityType: "conversion_action",
    resource: "campaign",
    timeSeries: true,
    description: "Conversions split by conversion action name and category. Cost, click, and impression metrics are intentionally omitted because they are not compatible with conversion action segmentation."
  },
  landing_page_performance: {
    entityType: "landing_page",
    resource: "landing_page_view",
    timeSeries: true,
    description: "Performance by unexpanded final URL."
  },
  expanded_landing_page_performance: {
    entityType: "landing_page",
    resource: "expanded_landing_page_view",
    timeSeries: true,
    description: "Performance by fully expanded final URL, including tracking-template expansion."
  },
  campaign_budgets: {
    entityType: "budget",
    resource: "campaign_budget",
    timeSeries: true,
    description: "Budget amounts, delivery method, sharing, and recommended budget with spend against each budget."
  },
  bidding_strategies: {
    entityType: "bidding_strategy",
    resource: "bidding_strategy",
    timeSeries: true,
    description: "Portfolio bidding strategy performance with type, status, and campaign count."
  },
  video_performance: {
    entityType: "video",
    resource: "video",
    timeSeries: true,
    description: "YouTube/video performance with views, view rate, CPV, and quartile completion rates."
  },
  call_performance: {
    entityType: "call",
    resource: "call_view",
    timeSeries: true,
    description: "Per-call records from Google Ads call reporting with duration, status, and caller area code. Pairs with the CallRail tools for full call attribution."
  },
  account_overview: {
    entityType: "account",
    resource: "customer",
    timeSeries: true,
    description: "Account-level totals with currency, time zone, optimization score, and auto-tagging status."
  },
  negative_keywords: {
    entityType: "negative_keyword",
    resource: "campaign_criterion",
    timeSeries: false,
    description: "Campaign-level negative keywords. Snapshot, not a time series."
  },
  shared_set_negative_keywords: {
    entityType: "negative_keyword",
    resource: "shared_criterion",
    timeSeries: false,
    description: "Negative keywords held in shared sets (negative keyword lists). Snapshot, not a time series."
  },
  change_history: {
    entityType: "change_event",
    resource: "change_event",
    timeSeries: false,
    dateField: "change_event.change_date_time",
    maxLookbackDays: 30,
    maxLimit: 10000,
    description: "Account change history: who changed what, when, and the old/new values. Google limits this to the last 30 days, requires a LIMIT, and caps results at 10000 rows."
  },
  recommendations: {
    entityType: "recommendation",
    resource: "recommendation",
    timeSeries: false,
    description: "Pending Google Ads recommendations with base and potential impact metrics. Snapshot, not a time series."
  },
  experiments: {
    entityType: "experiment",
    resource: "experiment",
    timeSeries: false,
    description: "Campaign experiments and drafts with type, status, and date range. Snapshot, not a time series."
  },
  click_view: {
    entityType: "click",
    resource: "click_view",
    timeSeries: true,
    singleDay: true,
    description: "GCLID-level click detail. Google requires a single-day filter and only retains the last 90 days. Uses endDate as the day."
  }
};
const GOOGLE_ADS_PRESET_NAMES = Object.keys(GOOGLE_ADS_PRESET_DEFINITIONS);
const GA4_PRESET_DEFINITIONS = {
  channels: { entityType: "channel", description: "Channel performance by session default channel group." },
  traffic_acquisition: { entityType: "channel", description: "Traffic acquisition: how sessions arrived, by channel, source, and medium." },
  user_acquisition: { entityType: "channel", description: "User acquisition: how users were first acquired, by first-user channel, source, and medium." },
  source_medium: { entityType: "source_medium", description: "Source / medium performance with sessions, users, and revenue." },
  campaigns: { entityType: "campaign", description: "GA4 campaign performance by session campaign and source / medium." },
  google_ads_performance: { entityType: "campaign", description: "Google Ads campaigns as seen by GA4, with ad cost, ad clicks, and ROAS. Requires a linked Google Ads account." },
  landing_pages: { entityType: "landing_page", description: "Landing page performance with channel and engagement context." },
  pages_and_screens: { entityType: "page", description: "Page and screen performance with views, users, and engagement time." },
  events: { entityType: "event", description: "All events with count, users, and count per user." },
  key_events: { entityType: "event", description: "Key event (conversion) performance by event name." },
  ecommerce: { entityType: "product", description: "Item and ecommerce performance by item name and category." },
  item_performance: { entityType: "product", description: "Detailed item performance with brand, category, views, add-to-carts, purchases, and revenue." },
  item_list_performance: { entityType: "product", description: "Item list and merchandising performance by list name." },
  promotions: { entityType: "product", description: "Internal promotion performance by promotion name." },
  ecommerce_funnel: { entityType: "funnel", description: "Ecommerce funnel by date: item views, add to carts, checkouts, and purchases with view-to-cart and view-to-purchase rates." },
  demographics: { entityType: "country", description: "Geographic performance by country, region, and city." },
  demographics_detail: { entityType: "demographic", description: "Age bracket, gender, and language. Requires Google signals; expect (not set) rows otherwise." },
  technology: { entityType: "device", description: "Device category, operating system, browser, and platform." },
  new_vs_returning: { entityType: "audience", description: "New versus returning user behaviour." },
  audiences: { entityType: "audience", description: "Performance by GA4 audience membership." },
  site_search: { entityType: "query", description: "Site search terms. Requires site search to be configured on the property." },
  engagement_overview: { entityType: "date", description: "Daily engagement: engagement rate, bounce rate, average session duration, and views per session." },
  daily_trends: { entityType: "date", description: "Daily sessions, users, new users, key events, and revenue." },
  attribution_breakdown: { entityType: "attribution", description: "Acquisition-style breakdown with session and first-user channel dimensions." }
};
const GA4_PRESET_NAMES = Object.keys(GA4_PRESET_DEFINITIONS);
const SEARCH_CONSOLE_PRESET_DEFINITIONS = {
  queries: { entityType: "query", dimensions: ["query"], description: "Search queries with clicks, impressions, CTR, and average position." },
  pages: { entityType: "page", dimensions: ["page"], description: "Landing pages or indexed URLs with search performance." },
  query_page_pairs: { entityType: "query", dimensions: ["query", "page"], description: "Which query drove which page. The core report for mapping intent to URLs." },
  striking_distance: { entityType: "query", dimensions: ["query", "page"], description: "Queries ranking just outside the top positions, where small gains move the needle. Filters client-side on average position and minimum impressions." },
  countries: { entityType: "country", dimensions: ["country"], description: "Country-level organic search performance." },
  devices: { entityType: "device", dimensions: ["device"], description: "Device-level organic search performance." },
  country_device: { entityType: "country", dimensions: ["country", "device"], description: "Country and device combined, for market plus form-factor analysis." },
  date_trends: { entityType: "date", dimensions: ["date"], description: "Date trend performance, optionally with a secondary breakdown." },
  date_query: { entityType: "date", dimensions: ["date", "query"], description: "Per-day query performance for tracking movement on specific terms." },
  date_page: { entityType: "date", dimensions: ["date", "page"], description: "Per-day page performance for tracking movement on specific URLs." },
  search_appearance: { entityType: "search_appearance", dimensions: ["searchAppearance"], description: "Rich result and search appearance types. Google does not allow searchAppearance to be combined with other dimensions." },
  branded_vs_non_branded: { entityType: "query_segment", dimensions: ["query"], description: "Branded or non-branded query performance using provided brand terms." },
  discover_performance: { entityType: "page", dimensions: ["page"], type: "discover", description: "Google Discover performance by page. Discover supports only date, country, and page dimensions." },
  news_performance: { entityType: "page", dimensions: ["page"], type: "googleNews", description: "Google News performance by page." }
};
const SEARCH_CONSOLE_PRESET_NAMES = Object.keys(SEARCH_CONSOLE_PRESET_DEFINITIONS);
const SEARCH_CONSOLE_MAX_ROW_LIMIT = 25000;
const MERCHANT_PRESET_DEFINITIONS = {
  product_performance: {
    entityType: "product",
    view: "ProductPerformanceView",
    table: "product_performance_view",
    description: "Product clicks, impressions, CTR, conversions and conversion value. Set marketingMethod to ORGANIC for free listings or ADS for Shopping ads."
  },
  product_status: {
    entityType: "product",
    view: "ProductView",
    table: "product_view",
    description: "Current feed snapshot: availability, condition, approval status per reporting context, click potential and item issues. Not a time series."
  },
  price_competitiveness: {
    entityType: "product",
    view: "PriceCompetitivenessProductView",
    table: "price_competitiveness_product_view",
    description: "Your price against the benchmark price other merchants charge for the same product. Requires reportCountryCode."
  },
  price_insights: {
    entityType: "product",
    view: "PriceInsightsProductView",
    table: "price_insights_product_view",
    description: "Google suggested price per product plus predicted clicks, impressions and conversions change at that price."
  },
  best_sellers: {
    entityType: "product",
    view: "BestSellersProductClusterView",
    table: "best_sellers_product_cluster_view",
    description: "Best selling product clusters with rank, relative demand and inventory status. Requires reportDate and reportCountryCode."
  },
  brand_performance: {
    entityType: "brand",
    view: "ProductPerformanceView",
    table: "product_performance_view",
    description: "Product performance rolled up by brand instead of individual offer."
  },
  category_performance: {
    entityType: "category",
    view: "ProductPerformanceView",
    table: "product_performance_view",
    description: "Product performance rolled up by top-level product category."
  },
  country_performance: {
    entityType: "country",
    view: "ProductPerformanceView",
    table: "product_performance_view",
    description: "Product performance rolled up by customer country and marketing method."
  },
  non_product_performance: {
    entityType: "account",
    view: "NonProductPerformanceView",
    table: "non_product_performance_view",
    description: "Traffic to non-product surfaces such as the store page, by date and country."
  },
  best_sellers_brands: {
    entityType: "brand",
    view: "BestSellersBrandView",
    table: "best_sellers_brand_view",
    description: "Best selling brands in a category with rank and relative demand. Requires reportDate and reportCountryCode."
  },
  competitive_visibility_benchmark: {
    entityType: "benchmark",
    view: "CompetitiveVisibilityBenchmarkView",
    table: "competitive_visibility_benchmark_view",
    description: "Category-level visibility benchmark trend you can compare your own visibility against. Requires reportCountryCode and reportCategoryId."
  },
  competitive_visibility_top_merchants: {
    entityType: "competitor",
    view: "CompetitiveVisibilityTopMerchantView",
    table: "competitive_visibility_top_merchant_view",
    description: "Top merchants competing in a category with rank and relative visibility. Requires reportCountryCode and reportCategoryId."
  },
  competitive_visibility: {
    entityType: "domain",
    view: "CompetitiveVisibilityCompetitorView",
    table: "competitive_visibility_competitor_view",
    description: "Competing domains in Shopping surfaces with relative visibility, page overlap and higher-position rate. Requires reportCountryCode."
  }
};
const PLATFORM_GUARDRAILS = {
  google_ads: {
    strengths: [
      "Best source for campaigns, ad groups, ads, keywords, search terms, assets, segments, and paid conversion reporting.",
      "GAQL can express complex filters, joins, and segmentation.",
      "Presets cover impression share, Quality Score, Shopping, Performance Max, geo, device, ad schedule, demographics, audiences, placements, conversion actions, landing pages, budgets, bidding strategies, video, calls, change history, recommendations, and experiments."
    ],
    limitations: [
      "Requires GOOGLE_ADS_DEVELOPER_TOKEN and often a login-customer-id for MCC access.",
      "Accuracy depends on using valid GAQL fields for the selected resource.",
      "Auction Insights is not exposed by the Google Ads API at all; no tool here can return it.",
      "Quality Score is a current attribute, not a historical series; it does not vary by date.",
      "Conversion action segmentation is incompatible with cost, click, and impression metrics.",
      "change_history is limited to the last 30 days and 10000 rows; click_view is single-day and limited to the last 90 days.",
      "Basic Access developer tokens are capped at roughly 15000 operations and 1000 requests per day. Every tool call is one request, so prefer one wide query over several narrow ones and page deliberately with pageToken."
    ],
    quota: {
      accessLevel: "Set GOOGLE_ADS_ACCESS_LEVEL to basic or standard to document which tier this token holds.",
      basicAccessDailyOperations: 15000,
      basicAccessDailyRequests: 1000,
      guidance: "One tool call equals one API request. Auto-pagination is deliberately not implemented so a single call cannot silently drain the daily quota."
    }
  },
  ga4: {
    strengths: [
      "Best source for web/app engagement, channels, landing pages, ecommerce, and event-driven conversion reporting.",
      "Metadata and compatibility APIs reduce invalid report combinations.",
      "Presets cover traffic and user acquisition, pages, events, key events, ecommerce and item detail, the ecommerce funnel, demographics, technology, audiences, site search, engagement, and daily trends.",
      "Funnel, cohort, custom definition, key event, and data stream tools cover the configuration and exploration surfaces that runReport alone cannot express."
    ],
    limitations: [
      "Not every GA4 UI exploration is mirrored exactly by a single Data API request.",
      "Attribution views depend on the available GA4 dimensions and metrics, not arbitrary UI-only widgets.",
      "GA4 renamed the conversions metric to keyEvents. Presets default to keyEvents; pass conversionMetric: \"conversions\" only if a property rejects the new name.",
      "GA4 applies data thresholding and sampling on some properties, so small segments can return suppressed or approximate rows.",
      "userAgeBracket and userGender require Google signals and otherwise return (not set).",
      "site_search requires site search to be configured; google_ads_performance requires a linked Google Ads account.",
      "Funnel reporting is only available on the Data API v1alpha surface, so its response shape differs from runReport."
    ]
  },
  search_console: {
    strengths: [
      "Authoritative for organic query, page, country, device, and search appearance performance.",
      "Presets cover query-to-page pairs, striking-distance opportunities, per-day movement, Discover, and Google News.",
      "compare_search_console_periods returns per-key deltas across two windows in one call."
    ],
    limitations: [
      "Search Analytics returns at most 25000 rows per request; page with startRow for more.",
      "Query data is anonymised, so the sum of query rows is lower than the site total.",
      "searchAppearance cannot be combined with any other dimension.",
      "Discover and Google News support only a subset of dimensions and have no query dimension.",
      "The most recent two to three days are incomplete unless dataState is set to all.",
      "Position is an average of averages, so it cannot be summed across rows."
    ]
  },
  merchant_center: {
    strengths: [
      "Authoritative for product feed status, item issues, free listing and Shopping ads performance, price competitiveness, price insights, best sellers, and competitive visibility.",
      "Presets roll product performance up by brand, category, and country as well as by individual offer.",
      "Organic marketing method reports free listings without any Google Ads account."
    ],
    limitations: [
      "Merchant API rejects calls with GCP_NOT_REGISTERED until the Cloud project is registered against the account.",
      "product_status, price_competitiveness, and price_insights are current snapshots and ignore the date range.",
      "best_sellers and best_sellers_brands require reportDate and reportCountryCode; the date is snapped to the start of the week or month.",
      "competitive_visibility, its benchmark, and top merchants all require reportCountryCode and a numeric reportCategoryId.",
      "Report queries use snake_case names while responses come back camelCase."
    ]
  },
  meta: {
    strengths: [
      "Best source for Meta Ads delivery and spend, Facebook Page organic reach and engagement, and Instagram organic performance.",
      "Ads presets cover account, campaign, ad set and ad levels plus age/gender, country, region, platform, device and placement breakdowns.",
      "Page and Instagram presets pivot Meta's metric-major insights into dated rows that join the other platforms."
    ],
    limitations: [
      "Meta has no refresh tokens. A long-lived user token lasts about 60 days; refreshing an MCP token re-extends it, but if the window lapses the user must re-authorize at /auth/meta/start.",
      "Every permission used here needs Meta App Review. Before approval only the app's own admins, developers and testers can grant them.",
      "Page and Instagram insights are documented against a Page access token, which costs one extra Graph request per call to resolve.",
      "Meta rotates and deprecates insight metric names between Graph versions. Presets carry defaults for the configured version and expose a metrics override; set META_GRAPH_API_VERSION to a version Meta still supports.",
      "Instagram follower demographics need at least 100 followers, and Instagram stories only cover the last 24 hours.",
      "Conversions are read from the actions array. Which action_type counts as a conversion depends on the pixel setup, so conversionActionType is configurable and the raw actions are always returned.",
      "Ads insights are attributed on Meta's own attribution windows, so Meta conversion counts will not tie out exactly against GA4 or Google Ads.",
      "Meta enforces per-app rate limits that vary with spend and app tier; no auto-pagination is performed, so page explicitly with the returned nextCursor."
    ]
  },
  callrail: {
    strengths: [
      "Best source for call records, trackers, summaries, time series, and CallRail-native attribution fields.",
      "Generic resource mode allows read-only expansion across supported CallRail endpoints.",
      "run_callrail_preset aggregates raw call records into grouped reports and emits normalized rows, so calls join to Google Ads, GA4, and Search Console."
    ],
    limitations: [
      "Transcripts, intent, recordings, and landing-page fields depend on account features and endpoint payloads.",
      "Coverage is limited to what CallRail returns via the public v3 API.",
      "CallRail has no server-side aggregation endpoint for most groupings, so presets aggregate one fetched page of calls. Check callsFetched against totalRecords before trusting totals, and page if they differ.",
      "A call carrying several tags is counted once per tag, so calls_by_tag totals can exceed the call total.",
      "Qualified calls are counted from lead_status = good_lead, which depends on the account actually scoring leads."
    ]
  }
};
const NORMALIZED_MARKETING_SCHEMA = {
  version: EXPERT_VERSION,
  recordShape: {
    platform: "google_ads | ga4 | search_console | merchant_center | callrail | meta",
    preset: "preset or custom normalization label",
    entityType: "campaign | ad_group | ad | keyword | search_term | asset | asset_group | product | product_group | geo | device | ad_schedule | age_range | gender | audience | placement | conversion_action | landing_page | budget | bidding_strategy | video | call | account | negative_keyword | change_event | recommendation | experiment | click | channel | source_medium | event | attribution | query | page | country | date | tracker",
    sourcePrimaryKey: "stable identifier from the source when available",
    dimensions: "normalized dimension dictionary",
    metrics: "normalized metric dictionary",
    sourceContext: "platform-native metadata needed for traceability"
  },
  standardDimensions: [
    "date",
    "campaign_id",
    "campaign_name",
    "ad_group_id",
    "ad_group_name",
    "keyword_text",
    "keyword_match_type",
    "search_term",
    "channel",
    "source_medium",
    "landing_page",
    "page",
    "query",
    "country",
    "device",
    "product_id",
    "product_title",
    "product_brand",
    "product_type",
    "call_id",
    "tracker_id",
    "ad_id",
    "ad_type",
    "asset_group_id",
    "asset_group_name",
    "region",
    "city",
    "day_of_week",
    "hour",
    "age_range",
    "gender",
    "audience",
    "placement",
    "conversion_action_name",
    "conversion_action_category",
    "budget_id",
    "budget_name",
    "bidding_strategy_name",
    "video_id",
    "video_title",
    "gclid",
    "currency",
    "source",
    "medium",
    "language",
    "operating_system",
    "browser",
    "search_appearance",
    "availability",
    "condition",
    "approval_status",
    "domain",
    "account_name",
    "call_segment",
    "event_name",
    "brand",
    "ad_account_id",
    "ad_name",
    "ad_set_id",
    "ad_set_name",
    "post_id",
    "media_id",
    "media_type",
    "placement",
    "publisher_platform"
  ],
  standardMetrics: [
    "impressions",
    "clicks",
    "cost",
    "ctr",
    "average_cpc",
    "conversions",
    "conversion_value",
    "sessions",
    "users",
    "engaged_sessions",
    "event_count",
    "revenue",
    "calls",
    "qualified_calls",
    "call_duration_seconds",
    "average_cpm",
    "all_conversions",
    "all_conversions_value",
    "cost_per_conversion",
    "value_per_conversion",
    "conversion_rate",
    "interactions",
    "interaction_rate",
    "search_impression_share",
    "search_budget_lost_impression_share",
    "search_rank_lost_impression_share",
    "search_top_impression_share",
    "search_absolute_top_impression_share",
    "absolute_top_impression_percentage",
    "top_impression_percentage",
    "quality_score",
    "video_views",
    "video_view_rate",
    "average_cpv",
    "new_users",
    "engagement_rate",
    "bounce_rate",
    "average_session_duration",
    "page_views",
    "event_value",
    "transactions",
    "items_viewed",
    "items_added_to_cart",
    "items_purchased",
    "return_on_ad_spend",
    "average_position",
    "answered_calls",
    "missed_calls",
    "first_time_callers",
    "average_call_duration_seconds",
    "answer_rate",
    "conversion_rate",
    "price",
    "benchmark_price",
    "suggested_price",
    "rank",
    "previous_rank",
    "relative_visibility",
    "page_overlap_rate",
    "higher_position_rate",
    "ads_organic_ratio",
    "click_potential_rank",
    "predicted_clicks_change",
    "predicted_conversions_change",
    "reach",
    "frequency",
    "engagements",
    "followers",
    "follower_adds",
    "follower_removes",
    "profile_views",
    "likes",
    "comments",
    "shares",
    "saves",
    "video_plays",
    "video_completions"
  ],
  crossSourceMappings: {
    campaign_name: {
      google_ads: ["campaign.name"],
      ga4: ["sessionCampaignName", "firstUserCampaignName"],
      search_console: [],
      merchant_center: [],
      callrail: ["utm_campaign", "campaign"],
      meta: ["campaign_name"]
    },
    channel: {
      google_ads: ["campaign.advertising_channel_type"],
      ga4: ["sessionDefaultChannelGroup", "firstUserDefaultChannelGroup"],
      search_console: ["searchType"],
      merchant_center: ["marketingMethod"],
      callrail: ["source", "medium", "channel"],
      meta: ["publisher_platform", "platform_position"]
    },
    landing_page: {
      google_ads: ["landing_page_view.unexpanded_final_url"],
      ga4: ["landingPagePlusQueryString"],
      search_console: ["page"],
      merchant_center: [],
      callrail: ["landing_page_url"],
      meta: ["permalink_url", "permalink"]
    },
    cost: {
      google_ads: ["metrics.cost_micros"],
      ga4: ["advertiserAdCost"],
      search_console: [],
      merchant_center: [],
      callrail: [],
      meta: ["spend"]
    }
  }
};
const MERCHANT_PRESET_NAMES = Object.keys(MERCHANT_PRESET_DEFINITIONS);
// CallRail returns raw call records rather than aggregated reports, so these presets
// declare which field to group by and the aggregation happens server-side here.
// Meta Ads insights are row-major; Page and Instagram insights are metric-major
// (one entry per metric, each holding a series of dated values). The normalizer
// pivots the latter into dated rows so all three surfaces land in one schema.
const META_ADS_BASE_FIELDS = "impressions,clicks,spend,reach,frequency,cpm,cpc,ctr,actions,action_values,cost_per_action_type,purchase_roas,account_currency,date_start,date_stop";
const META_ADS_VIDEO_FIELDS = "impressions,spend,video_play_actions,video_thruplay_watched_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions";
const META_CONVERSION_ACTION_TYPES = [
  "offsite_conversion.fb_pixel_purchase",
  "omni_purchase",
  "purchase",
  "onsite_web_purchase"
];
const META_PRESET_DEFINITIONS = {
  ads_account_performance: { surface: "ads", shape: "insights", entityType: "account", level: "account", description: "Ad account totals: spend, impressions, clicks, reach, frequency, conversions and ROAS." },
  ads_campaign_performance: { surface: "ads", shape: "insights", entityType: "campaign", level: "campaign", description: "Campaign performance with spend, delivery, conversions and ROAS." },
  ads_adset_performance: { surface: "ads", shape: "insights", entityType: "ad_set", level: "adset", description: "Ad set performance with campaign context." },
  ads_ad_performance: { surface: "ads", shape: "insights", entityType: "ad", level: "ad", description: "Ad-level performance with campaign and ad set context." },
  ads_daily_trends: { surface: "ads", shape: "insights", entityType: "date", level: "account", timeIncrement: 1, description: "Daily account spend and delivery over the window." },
  ads_by_age_gender: { surface: "ads", shape: "insights", entityType: "demographic", level: "account", breakdowns: "age,gender", description: "Spend and results split by age bracket and gender." },
  ads_by_country: { surface: "ads", shape: "insights", entityType: "country", level: "account", breakdowns: "country", description: "Spend and results split by country." },
  ads_by_region: { surface: "ads", shape: "insights", entityType: "country", level: "account", breakdowns: "region", description: "Spend and results split by region." },
  ads_by_platform: { surface: "ads", shape: "insights", entityType: "placement", level: "account", breakdowns: "publisher_platform,platform_position", description: "Spend split across Facebook, Instagram, Audience Network and Messenger, and position within each." },
  ads_by_device: { surface: "ads", shape: "insights", entityType: "device", level: "account", breakdowns: "impression_device", description: "Spend and results split by impression device." },
  ads_by_placement: { surface: "ads", shape: "insights", entityType: "placement", level: "campaign", breakdowns: "publisher_platform,platform_position,device_platform", description: "Full placement breakdown at campaign level." },
  ads_video_performance: { surface: "ads", shape: "insights", entityType: "ad", level: "ad", fields: "video", description: "Video ad performance with plays, ThruPlays and quartile completions." },
  ads_conversions: { surface: "ads", shape: "insights", entityType: "campaign", level: "campaign", description: "Campaign conversions and conversion value by action type, with cost per action and ROAS." },
  page_overview: { surface: "page", shape: "metric_series", entityType: "page", period: "day", metrics: "page_impressions,page_impressions_unique,page_post_engagements,page_views_total", description: "Facebook Page reach, impressions, engagement and views per day." },
  page_daily_trends: { surface: "page", shape: "metric_series", entityType: "date", period: "day", metrics: "page_impressions,page_impressions_unique,page_post_engagements", description: "Daily Page impressions, reach and engagement." },
  page_audience: { surface: "page", shape: "metric_series", entityType: "page", period: "day", metrics: "page_fans,page_fan_adds,page_fan_removes", description: "Page follower count with daily adds and removes." },
  page_posts: { surface: "page", shape: "edge", entityType: "post", edge: "posts", description: "Recent Page posts with per-post impressions, reach, engaged users and clicks." },
  instagram_account_overview: { surface: "instagram", shape: "metric_series", entityType: "account", period: "day", metrics: "reach,profile_views", description: "Instagram account reach and profile views per day." },
  instagram_daily_trends: { surface: "instagram", shape: "metric_series", entityType: "date", period: "day", metrics: "reach,follower_count", description: "Daily Instagram reach and follower change." },
  instagram_media_performance: { surface: "instagram", shape: "edge", entityType: "media", edge: "media", description: "Instagram posts with likes, comments, reach, saves, shares and total interactions." },
  instagram_stories: { surface: "instagram", shape: "edge", entityType: "media", edge: "stories", description: "Instagram stories from the last 24 hours with reach and replies." },
  instagram_audience: { surface: "instagram", shape: "demographics", entityType: "demographic", metrics: "follower_demographics", description: "Instagram follower demographics. Requires at least 100 followers or Meta returns no data." }
};
const META_PRESET_NAMES = Object.keys(META_PRESET_DEFINITIONS);
const CALLRAIL_PRESET_DEFINITIONS = {
  call_details: { entityType: "call", groupBy: null, description: "Individual call records with attribution, duration, and lead status. Not aggregated." },
  calls_overview: { entityType: "account", groupBy: null, aggregateAll: true, description: "Single-row summary: total, answered, missed, first-time callers, total and average duration, and lead value." },
  calls_by_source: { entityType: "source_medium", groupBy: "source", description: "Call volume and outcomes grouped by CallRail source." },
  calls_by_medium: { entityType: "source_medium", groupBy: "medium", description: "Call volume and outcomes grouped by medium." },
  calls_by_campaign: { entityType: "campaign", groupBy: "campaign", description: "Call volume and outcomes grouped by campaign." },
  calls_by_keyword: { entityType: "query", groupBy: "keywords", description: "Call volume grouped by the keyword CallRail captured." },
  calls_by_landing_page: { entityType: "landing_page", groupBy: "landing_page_url", description: "Call volume grouped by the landing page the caller arrived on." },
  calls_by_referrer: { entityType: "source_medium", groupBy: "referrer", description: "Call volume grouped by referring site." },
  calls_by_tracker: { entityType: "tracker", groupBy: "tracking_phone_number", description: "Call volume grouped by tracking number." },
  calls_by_company: { entityType: "account", groupBy: "company_name", description: "Call volume grouped by CallRail company." },
  calls_by_device: { entityType: "device", groupBy: "device_type", description: "Call volume grouped by caller device type." },
  calls_by_city: { entityType: "country", groupBy: "customer_city", description: "Call volume grouped by caller city." },
  calls_by_lead_status: { entityType: "call_segment", groupBy: "lead_status", description: "Call volume grouped by lead status, for qualified versus unqualified analysis." },
  calls_by_tag: { entityType: "call_segment", groupBy: "tags", description: "Call volume grouped by tag. Calls carrying several tags are counted once per tag." },
  answered_vs_missed: { entityType: "call_segment", groupBy: "answered", description: "Answered versus missed call split." },
  first_time_vs_repeat: { entityType: "call_segment", groupBy: "first_call", description: "First-time callers versus repeat callers." },
  call_duration_buckets: { entityType: "call_segment", groupBy: "duration_bucket", description: "Calls bucketed by duration, for filtering out short non-conversations." },
  daily_call_trends: { entityType: "date", groupBy: "call_date", description: "Calls per day over the window." }
};
const CALLRAIL_PRESET_NAMES = Object.keys(CALLRAIL_PRESET_DEFINITIONS);
// Requested explicitly so attribution fields come back rather than CallRail's default subset.
const CALLRAIL_PRESET_FIELDS = "answered,business_phone_number,campaign,company_id,company_name,customer_city,customer_country,customer_name,customer_phone_number,customer_state,device_type,direction,duration,first_call,gclid,keywords,landing_page_url,lead_status,medium,prior_calls,referrer,referring_url,source,source_name,start_time,tags,total_calls,tracking_phone_number,utm_campaign,utm_content,utm_medium,utm_source,utm_term,value,voicemail";
const sessionStore = globalThis.__googleMcpSessionStore || new Map();
globalThis.__googleMcpSessionStore = sessionStore;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getBaseUrl(req) {
  const raw = process.env.APP_BASE_URL || process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
  return String(raw).replace(/\/+$/, "");
}

function getResourceUrl(req) {
  return `${getBaseUrl(req)}/mcp`;
}

// Issuer and resource are compared against values a client echoes back to us, and
// clients are not consistent about trailing slashes or host casing. Treating those
// as a mismatch rejects a perfectly good token, and a rejected token is what makes
// a connector ask the user to sign in again.
function urlsMatch(a, b) {
  if (!a || !b) return false;
  const normalize = (value) => String(value).trim().replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

// A resource may legitimately arrive as either the MCP endpoint or the server root.
function resourcesMatch(requested, expected) {
  if (urlsMatch(requested, expected)) return true;
  const stripMcp = (value) => String(value).trim().replace(/\/+$/, "").replace(/\/mcp$/i, "");
  return urlsMatch(stripMcp(requested), stripMcp(expected));
}

// Google answers a dead grant (revoked access, deleted client, changed password) with
// one of these. Anything else - a network blip, a 429, a 5xx - is transient, and must
// not cost the user their connection.
const PERMANENT_GOOGLE_AUTH_ERRORS = ["invalid_grant", "invalid_client", "unauthorized_client"];

function isPermanentGoogleAuthFailure(error) {
  const haystack = [
    error?.response?.data?.error,
    error?.response?.data?.error_description,
    error?.message
  ].filter(Boolean).join(" ").toLowerCase();
  return PERMANENT_GOOGLE_AUTH_ERRORS.some((code) => haystack.includes(code));
}

function getCallRailBaseUrl() {
  return String(process.env.CALLRAIL_API_BASE_URL || "https://api.callrail.com/v3").replace(/\/+$/, "");
}

function getMetaGraphApiVersion() {
  // Meta deprecates Graph versions roughly two years after release, so this is
  // deliberately env-driven rather than pinned in code.
  return String(process.env.META_GRAPH_API_VERSION || "v21.0").trim();
}

function getMetaGraphBaseUrl() {
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}`;
}

function requireMetaAppId() {
  return requireEnv("META_APP_ID");
}

function requireMetaAppSecret() {
  return requireEnv("META_APP_SECRET");
}

// Facebook Login for Business drives permissions from a Business Login Configuration
// rather than a scope list, which is what gives the user the asset picker.
function getMetaLoginConfigId(value) {
  const candidate = value || process.env.META_LOGIN_CONFIG_ID;
  return candidate ? String(candidate).trim() : null;
}

// MCP clients only ever visit the advertised authorization_endpoint, which is the
// Google one, so a connector could never reach the Meta flow on its own. When Meta
// is configured, the Google callback hands off to Meta consent before issuing the
// authorization code, so one connector approval covers both providers.
const AUTH_PAGE_GOOGLE_MARK = [
  '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">',
  '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>',
  '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>',
  '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>',
  '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>',
  '</svg>'
].join("");

const AUTH_PAGE_META_MARK = [
  '<svg viewBox="0 0 48 32" aria-hidden="true" focusable="false">',
  '<defs><linearGradient id="metaMark" x1="0" y1="0" x2="1" y2="1">',
  '<stop offset="0%" stop-color="#0064E0"/><stop offset="100%" stop-color="#0082FB"/>',
  '</linearGradient></defs>',
  '<path d="M7 16c0-5 2.6-8.6 6.2-8.6 4.6 0 7.2 8.6 10.8 8.6S30.2 7.4 34.8 7.4C38.4 7.4 41 11 41 16s-2.6 8.6-6.2 8.6c-4.6 0-7.2-8.6-10.8-8.6S17.8 24.6 13.2 24.6C9.6 24.6 7 21 7 16z" ',
  'fill="none" stroke="url(#metaMark)" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>'
].join("");

const AUTH_PAGE_CALLRAIL_MARK = [
  '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">',
  '<rect width="32" height="32" rx="8" fill="#0A2540"/>',
  '<path d="M11.4 10.2c.5-.5 1.3-.5 1.8 0l1.7 1.7c.5.5.5 1.3 0 1.8l-1 1c-.3.3-.4.7-.2 1 .8 1.6 2 2.8 3.6 3.6.3.2.7.1 1-.2l1-1c.5-.5 1.3-.5 1.8 0l1.7 1.7c.5.5.5 1.3 0 1.8l-.9.9c-1 1-2.5 1.3-3.8.7-3.6-1.6-6.5-4.5-8.1-8.1-.6-1.3-.3-2.8.7-3.8z" fill="#fff"/>',
  '</svg>'
].join("");

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// The detail line says what the account actually buys you, so "Optional" reads as a
// real choice with known stakes rather than a step the user is failing to complete.
const AUTH_PROVIDER_DETAIL = {
  Google: "Ads, Analytics, Search Console, Merchant Center",
  Meta: "Facebook and Instagram",
  CallRail: "Call tracking, recordings and call attribution"
};

function renderAuthProviderRow(mark, name, status) {
  const label = {
    connected: "Connected",
    connecting: "Connecting",
    pending: "Next",
    optional: "Optional",
    skipped: "Not connected",
    failed: "Couldn't connect"
  }[status] || status;
  const icon = status === "connected"
    ? '<svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 4.5l-7 7-4-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : status === "connecting"
      ? '<span class="spinner" aria-hidden="true"></span>'
      : "";
  const detail = AUTH_PROVIDER_DETAIL[name];
  return [
    '<li class="row row--' + escapeHtml(status) + '">',
    '<span class="mark">' + mark + '</span>',
    '<span class="who">',
    '<span class="name">' + escapeHtml(name) + '</span>',
    detail ? '<span class="detail">' + escapeHtml(detail) + '</span>' : "",
    '</span>',
    '<span class="status">' + icon + '<span>' + escapeHtml(label) + '</span></span>',
    '</li>'
  ].join("");
}

// These pages sit inside the OAuth redirect chain, so they must carry the browser
// onward without JavaScript too: the meta refresh and the manual link are fallbacks
// for when script is blocked.
const AUTH_PAGE_STYLES = [
    ":root{color-scheme:light dark;",
    "--bg:#f6f7f9;--card:#fff;--ink:#12141a;--muted:#5b6070;--line:#e4e6ec;",
    "--accent:#1a73e8;--ok:#1a7f4b;--warn:#a8620a;}",
    "@media (prefers-color-scheme:dark){:root{",
    "--bg:#0d0f14;--card:#161923;--ink:#f2f4f8;--muted:#9aa1b2;--line:#272b38;",
    "--accent:#7ca9ff;--ok:#5fd39b;--warn:#e0a75e;}}",
    "*{box-sizing:border-box}",
    "body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;",
    "background:var(--bg);color:var(--ink);",
    "font:15px/1.55 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif}",
    ".card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);",
    "border-radius:16px;padding:32px 28px;box-shadow:0 1px 2px rgba(0,0,0,.05),0 12px 32px rgba(0,0,0,.06)}",
    "h1{margin:0 0 8px;font-size:21px;line-height:1.3;letter-spacing:-.01em}",
    ".sub{margin:0 0 24px;color:var(--muted)}",
    "ul{list-style:none;margin:0 0 22px;padding:0;border:1px solid var(--line);border-radius:12px;overflow:hidden}",
    ".row{display:flex;align-items:center;gap:12px;padding:14px 16px}",
    ".row+.row{border-top:1px solid var(--line)}",
    ".mark{display:grid;place-items:center;width:26px;height:26px;flex:none}",
    ".mark svg{width:100%;height:auto;display:block}",
    ".who{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
    ".name{font-weight:600}",
    ".detail{font-size:12px;color:var(--muted);line-height:1.35}",
    ".status{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}",
    ".row--connected .status{color:var(--ok);font-weight:600}",
    ".row--connecting .status{color:var(--accent);font-weight:600}",
    ".row--failed .status,.row--skipped .status{color:var(--warn);font-weight:600}",
    ".row--optional .status{color:var(--muted)}",
    ".row--optional .mark{opacity:.55}",
    ".tick{width:15px;height:15px}",
    ".spinner{width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;",
    "border-radius:50%;animation:spin .7s linear infinite}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
    "@media (prefers-reduced-motion:reduce){.spinner{animation:none;opacity:.6}}",
    ".cta{display:block;text-align:center;text-decoration:none;font-weight:600;",
    "padding:11px 16px;border-radius:10px;background:var(--accent);color:#fff}",
    ".cta:focus-visible{outline:3px solid var(--accent);outline-offset:2px}",
    ".cta--ghost{margin-top:10px;background:transparent;color:var(--muted);",
    "font-weight:500;border:1px solid var(--line)}",
    ".cta--ghost:hover{color:var(--ink)}",
    ".note{margin:16px 0 0;font-size:12.5px;color:var(--muted);text-align:center}",
    ".cta{width:100%;border:0;cursor:pointer;font:inherit;font-weight:600}",
    "button.cta{-webkit-appearance:none;appearance:none}",
].join("");

function renderAuthStatusPage(options = {}) {
  const {
    title = "Connecting",
    heading = "",
    message = "",
    google = "connected",
    meta = "pending",
    callrail = "hidden",
    redirectUrl = null,
    redirectDelayMs = 1800,
    continueLabel = "Continue",
    tone = "progress",
    footnote = "",
    secondaryUrl = null,
    secondaryLabel = "",
    // A screen that asks the user a question must not answer it for them, so any
    // page offering a genuine choice turns the auto-advance off and waits.
    autoAdvance = true
  } = options;

  const delaySeconds = Math.max(0, Math.round(redirectDelayMs / 100) / 10);
  const safeRedirect = redirectUrl ? escapeHtml(redirectUrl) : null;
  const safeSecondary = secondaryUrl && secondaryLabel ? escapeHtml(secondaryUrl) : null;
  const advances = Boolean(safeRedirect && autoAdvance);

  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    advances ? '<meta http-equiv="refresh" content="' + delaySeconds + ';url=' + safeRedirect + '">' : "",
    "<title>" + escapeHtml(title) + "</title>",
    "<style>",
    AUTH_PAGE_STYLES,
    "</style></head><body>",
    '<main class="card" role="status" aria-live="polite">',
    "<h1>" + escapeHtml(heading) + "</h1>",
    message ? '<p class="sub">' + escapeHtml(message) + "</p>" : "",
    "<ul>",
    renderAuthProviderRow(AUTH_PAGE_GOOGLE_MARK, "Google", google),
    renderAuthProviderRow(AUTH_PAGE_META_MARK, "Meta", meta),
    callrail === "hidden" ? "" : renderAuthProviderRow(AUTH_PAGE_CALLRAIL_MARK, "CallRail", callrail),
    "</ul>",
    safeRedirect ? '<a class="cta" href="' + safeRedirect + '">' + escapeHtml(continueLabel) + "</a>" : "",
    safeSecondary ? '<a class="cta cta--ghost" href="' + safeSecondary + '">' + escapeHtml(secondaryLabel) + "</a>" : "",
    footnote ? '<p class="note">' + escapeHtml(footnote) + "</p>" : "",
    advances ? '<p class="note">Taking you there automatically. Use the button if nothing happens.</p>' : "",
    "</main>",
    // A click must win the race against any pending auto-redirect, otherwise choosing
    // the optional path would be silently undone a moment later.
    advances
      ? "<script>(function(){var t=setTimeout(function(){location.replace("
        + JSON.stringify(redirectUrl) + ")}," + redirectDelayMs + ");"
        + "document.addEventListener('click',function(e){if(e.target.closest('a'))clearTimeout(t)});})()<\/script>"
      : "",
    "</body></html>"
  ].filter(Boolean).join("");
}

// CallRail authenticates with an API key rather than a redirect, so this screen has to
// collect one. The key is posted straight back to this server over HTTPS, sealed into
// the session token, and never rendered back to the page.
function renderCallRailConnectPage(options = {}) {
  const {
    chain = "",
    skipUrl = null,
    errorMessage = "",
    google = "connected",
    meta = "optional",
    heading = "Connect CallRail",
    message = "Paste a CallRail API key to query your own call data. Everything else already works without it."
  } = options;

  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    '<meta name="referrer" content="no-referrer">',
    "<title>" + escapeHtml(heading) + "</title>",
    "<style>",
    AUTH_PAGE_STYLES,
    ".field{display:block;margin:0 0 16px}",
    ".field label{display:block;font-weight:600;font-size:13.5px;margin:0 0 6px}",
    ".field input{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);",
    "background:var(--bg);color:var(--ink);font:inherit;font-size:14px}",
    ".field input:focus-visible{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}",
    ".hint{margin:6px 0 0;font-size:12.5px;color:var(--muted)}",
    ".err{margin:0 0 16px;padding:11px 13px;border-radius:10px;font-size:13.5px;",
    "background:rgba(200,60,40,.10);border:1px solid rgba(200,60,40,.35);color:var(--warn)}",
    "</style></head><body>",
    '<main class="card">',
    "<h1>" + escapeHtml(heading) + "</h1>",
    '<p class="sub">' + escapeHtml(message) + "</p>",
    "<ul>",
    renderAuthProviderRow(AUTH_PAGE_GOOGLE_MARK, "Google", google),
    renderAuthProviderRow(AUTH_PAGE_META_MARK, "Meta", meta),
    renderAuthProviderRow(AUTH_PAGE_CALLRAIL_MARK, "CallRail", "optional"),
    "</ul>",
    errorMessage ? '<p class="err" role="alert">' + escapeHtml(errorMessage) + "</p>" : "",
    '<form method="post" action="/auth/callrail" autocomplete="off">',
    '<input type="hidden" name="chain" value="' + escapeHtml(chain) + '">',
    '<span class="field">',
    '<label for="apiKey">CallRail API key</label>',
    '<input id="apiKey" name="apiKey" type="password" required autocomplete="off" ',
    'spellcheck="false" autocapitalize="off" placeholder="Paste your API key">',
    '<span class="hint">CallRail: Account &rarr; Integrations &rarr; API Keys. Stored encrypted in this connection only. It stays until you remove or reconnect the connector, and is never shown again.</span>',
    "</span>",
    '<button class="cta" type="submit">Connect CallRail</button>',
    "</form>",
    skipUrl ? '<a class="cta cta--ghost" href="' + escapeHtml(skipUrl) + '">Skip &mdash; finish without CallRail</a>' : "",
    '<p class="note">CallRail is optional. Without it the CallRail tools stay switched off and nothing else changes.</p>',
    "</main></body></html>"
  ].filter(Boolean).join("");
}

function sendCallRailConnectPage(res, options = {}) {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-store");
  // The key is typed on this page, so keep it out of referrers and out of any cache.
  res.set("Referrer-Policy", "no-referrer");
  return res.status(options.httpStatus || 200).send(renderCallRailConnectPage(options));
}

// Validating against a cheap endpoint proves the key works and names the account, so
// a typo is caught here rather than surfacing later as a confusing tool failure.
async function verifyCallRailKey(apiKey) {
  const response = await callCallRailApi("/a.json", {}, apiKey);
  if (!response.ok) {
    const detail = response.status === 401 || response.status === 403
      ? "CallRail rejected that key. Check it was copied whole and is still active."
      : `CallRail returned HTTP ${response.status}.`;
    return { ok: false, message: detail };
  }
  const accounts = response.body?.accounts || [];
  return {
    ok: true,
    accountId: accounts[0]?.id ? String(accounts[0].id) : null,
    accountName: accounts[0]?.name || null,
    accountCount: accounts.length
  };
}

function sendAuthStatusPage(res, options) {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-store");
  return res.status(options.httpStatus || 200).send(renderAuthStatusPage(options));
}

function isMetaConfigured() {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

// Google is the only provider required to use this server; Meta is an add-on. After
// Google consent the user is *asked* whether to add Meta, never sent there. Turning
// this off skips the question entirely and finishes on Google alone, which is what a
// deployment wants while its Meta app is still unreviewed or in Development mode.
function shouldOfferMetaAfterGoogle(requestedValue) {
  if (!isMetaConfigured()) return false;
  if (requestedValue !== undefined && requestedValue !== null && requestedValue !== "") {
    return !["0", "false", "no"].includes(String(requestedValue).toLowerCase());
  }
  const configured = process.env.META_OFFER_AFTER_GOOGLE ?? process.env.META_CHAIN_AFTER_GOOGLE ?? "true";
  return !["0", "false", "no"].includes(String(configured).toLowerCase());
}

function getMetaRedirectUri(req) {
  return `${getBaseUrl(req)}/auth/meta/callback`;
}

// Meta signs API calls with appsecret_proof when the app has it enabled, and
// accepts it unconditionally, so it is always sent.
function buildMetaAppSecretProof(accessToken) {
  return crypto.createHmac("sha256", requireMetaAppSecret()).update(String(accessToken)).digest("hex");
}

async function callMetaGraphApi(pathOrUrl, accessToken, params = {}) {
  const url = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(`${getMetaGraphBaseUrl()}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`);
  appendQueryParams(url, params);
  if (accessToken) {
    url.searchParams.set("access_token", String(accessToken));
    try {
      url.searchParams.set("appsecret_proof", buildMetaAppSecretProof(accessToken));
    } catch {
      // META_APP_SECRET missing; the call will fail on its own with a clearer error.
    }
  }
  const response = await fetch(url.toString(), { method: "GET" });
  const rawBody = await response.text();
  let parsedBody = rawBody;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {}
  // Never log the token or the proof.
  const safeUrl = new URL(url.toString());
  safeUrl.searchParams.delete("access_token");
  safeUrl.searchParams.delete("appsecret_proof");
  console.log(JSON.stringify({ type: "meta_api_debug", url: safeUrl.toString(), status: response.status, body: parsedBody }));
  return { ok: response.ok, status: response.status, body: parsedBody };
}

function toMetaDebugPayload(response) {
  return response.ok ? response.body : { status: response.status, error: response.body };
}

async function exchangeMetaCodeForToken(req, code) {
  const url = new URL(`${getMetaGraphBaseUrl()}/oauth/access_token`);
  appendQueryParams(url, {
    client_id: requireMetaAppId(),
    client_secret: requireMetaAppSecret(),
    redirect_uri: getMetaRedirectUri(req),
    code
  });
  const response = await fetch(url.toString(), { method: "GET" });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Meta code exchange failed: ${JSON.stringify(body)}`);
  }
  return body;
}

// Meta has no refresh tokens. A short-lived user token is exchanged for a long-lived
// one (~60 days), and re-exchanging a still-valid long-lived token resets that window.
async function exchangeMetaLongLivedToken(shortLivedToken) {
  const url = new URL(`${getMetaGraphBaseUrl()}/oauth/access_token`);
  appendQueryParams(url, {
    grant_type: "fb_exchange_token",
    client_id: requireMetaAppId(),
    client_secret: requireMetaAppSecret(),
    fb_exchange_token: shortLivedToken
  });
  const response = await fetch(url.toString(), { method: "GET" });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Meta long-lived token exchange failed: ${JSON.stringify(body)}`);
  }
  return body;
}

async function debugMetaToken(accessToken) {
  const url = new URL(`${getMetaGraphBaseUrl()}/debug_token`);
  appendQueryParams(url, {
    input_token: accessToken,
    access_token: `${requireMetaAppId()}|${requireMetaAppSecret()}`
  });
  const response = await fetch(url.toString(), { method: "GET" });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

function buildMetaCredentials(tokenResponse, grantedScopes, userId) {
  const expiresInSeconds = toNumber(tokenResponse?.expires_in);
  return {
    accessToken: tokenResponse?.access_token,
    tokenType: tokenResponse?.token_type || "bearer",
    // Meta omits expires_in for tokens that do not expire; treat that as no expiry.
    expiresAt: expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : null,
    scope: Array.isArray(grantedScopes) ? grantedScopes.join(" ") : String(grantedScopes || ""),
    userId: userId || null
  };
}

function getGoogleAdsApiVersion() {
  return String(process.env.GOOGLE_ADS_API_VERSION || "v22").trim();
}

function getEncryptionKey() {
  const encodedKey = process.env.APP_ENCRYPTION_KEY;
  if (encodedKey) {
    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    return key;
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (sessionSecret) {
    return crypto.createHash("sha256").update(sessionSecret).digest();
  }

  throw new Error("Missing required environment variable: APP_ENCRYPTION_KEY or SESSION_SECRET");
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
}

function encryptJson(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [base64UrlEncode(iv), base64UrlEncode(cipher.getAuthTag()), base64UrlEncode(ciphertext)].join(".");
}

function decryptJson(token) {
  const [ivPart, tagPart, cipherPart] = String(token || "").split(".");
  if (!ivPart || !tagPart || !cipherPart) throw new Error("Malformed token.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), base64UrlDecode(ivPart));
  decipher.setAuthTag(base64UrlDecode(tagPart));
  const plaintext = Buffer.concat([decipher.update(base64UrlDecode(cipherPart)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

function sha256Base64Url(value) {
  return base64UrlEncode(crypto.createHash("sha256").update(value).digest());
}

function isLoopbackRedirectUri(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function registerOauthClient(req, body = {}) {
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String).filter(Boolean) : [];
  if (!redirectUris.length) throw new Error("redirect_uris is required.");
  for (const uri of redirectUris) {
    try {
      new URL(uri);
    } catch {
      throw new Error(`Invalid redirect_uri: ${uri}`);
    }
  }
  const issuedAt = Date.now();
  const clientName = body.client_name ? String(body.client_name).slice(0, 200) : undefined;
  const clientId = encryptJson({
    typ: "mcp_client_registration",
    iss: getBaseUrl(req),
    redirectUris,
    clientName,
    iat: issuedAt,
    exp: issuedAt + CLIENT_REGISTRATION_TTL_MS
  });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(issuedAt / 1000),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: GOOGLE_SCOPES.join(" "),
    ...(clientName ? { client_name: clientName } : {})
  };
}

function readClientRegistration(req, clientId) {
  if (!clientId) return null;
  let payload;
  try {
    payload = decryptJson(String(clientId));
  } catch {
    return null;
  }
  if (payload.typ !== "mcp_client_registration") return null;
  if (!urlsMatch(payload.iss, getBaseUrl(req))) return null;
  if (payload.exp && Number(payload.exp) <= Date.now()) return null;
  return payload;
}

function buildInvalidRedirectUriError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.oauthError = "invalid_request";
  return error;
}

function resolveClientRedirectUri(req) {
  const requested = req.query.redirect_uri ? String(req.query.redirect_uri) : null;
  if (!requested) return null;
  const registration = readClientRegistration(req, req.query.client_id);
  if (registration) {
    if (!registration.redirectUris.includes(requested)) {
      throw buildInvalidRedirectUriError("redirect_uri does not match the redirect URIs registered for this client_id.");
    }
    return requested;
  }
  if (isLoopbackRedirectUri(requested)) return requested;
  throw buildInvalidRedirectUriError(
    "Unregistered redirect_uri. Register the client at /register first, or use a loopback redirect URI."
  );
}

function createOauthClient(req) {
  return new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET"),
    `${getBaseUrl(req)}/auth/google/callback`
  );
}

function logAuthRouteDebug(payload) {
  console.log(JSON.stringify({ type: "auth_route_debug", ...payload }));
}

function normalizePropertyName(propertyId) {
  return propertyId.startsWith("properties/") ? propertyId : `properties/${propertyId}`;
}

function normalizeGoogleAdsCustomerId(customerId) {
  return String(customerId || "").replace(/-/g, "").trim();
}

function normalizeMerchantAccountName(accountName) {
  const normalized = String(accountName || "").trim();
  return normalized.startsWith("accounts/") ? normalized : `accounts/${normalized}`;
}

function normalizeScopes(scopeValue) {
  if (!scopeValue) return [...GOOGLE_SCOPES];
  const requested = String(scopeValue).split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const allowed = requested.filter((scope) => ALL_KNOWN_SCOPES.includes(scope));
  return allowed.length ? Array.from(new Set(allowed)) : [...GOOGLE_SCOPES];
}

// normalizeScopes is deliberately permissive because session and token scope strings
// can hold a Google + Meta union. Anything that builds a Google authorization URL must
// use this instead, or a Meta scope would reach Google and be rejected as invalid_scope.
// A session can hold Google credentials, Meta credentials, or both, and each provider
// only ever reports its own scopes. Deriving the union from the credentials actually
// present stops one provider's scope string from overwriting the other's, which would
// silently strip the second provider's permissions from the minted token.
function buildSessionScope({ googleScope, metaScope, hasCallRail, fallbackScope } = {}) {
  const google = googleScope ? normalizeGoogleAuthScopes(googleScope) : [];
  const meta = metaScope ? normalizeMetaScopes(metaScope) : [];
  const callrail = hasCallRail ? [CALLRAIL_SCOPE] : [];
  const combined = Array.from(new Set([...google, ...meta, ...callrail]));
  return combined.length ? combined.join(" ") : String(fallbackScope || "");
}

function normalizeGoogleAuthScopes(scopeValue) {
  if (!scopeValue) return [...GOOGLE_SCOPES];
  const requested = String(scopeValue).split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const allowed = requested.filter((scope) => GOOGLE_SCOPES.includes(scope));
  return allowed.length ? Array.from(new Set(allowed)) : [...GOOGLE_SCOPES];
}

function normalizeMetaScopes(scopeValue) {
  if (!scopeValue) return [...META_SCOPES];
  const requested = String(scopeValue).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const allowed = requested.filter((scope) => META_SCOPES.includes(scope));
  return allowed.length ? Array.from(new Set(allowed)) : [...META_SCOPES];
}

function scopesInclude(scopes, candidates) {
  return scopes.some((scope) => candidates.includes(scope));
}

function hasScopes(grantedScopes, requiredScopes) {
  return requiredScopes.every((scope) => grantedScopes.includes(scope));
}

function buildAuthError({ httpStatus = 401, error = "invalid_token", errorDescription, details = {} }) {
  const authError = new Error(errorDescription);
  authError.statusCode = httpStatus;
  authError.oauthError = error;
  authError.oauthErrorDescription = errorDescription;
  authError.details = details;
  return authError;
}

function formatAuthErrorResponse(error) {
  return {
    error: error.oauthError || "invalid_token",
    error_description: error.oauthErrorDescription || error.message,
    ...error.details
  };
}

function getAuthenticateHeader(error) {
  const parts = ['Bearer realm="mcp"'];
  if (error.oauthError) parts.push(`error="${error.oauthError}"`);
  if (error.oauthErrorDescription) parts.push(`error_description="${String(error.oauthErrorDescription).replace(/"/g, "'")}"`);
  if (error.details?.required_scopes?.length) parts.push(`scope="${error.details.required_scopes.join(" ")}"`);
  return parts.join(", ");
}

function logAuthorizationDebug(req) {
  const authHeader = req.headers.authorization;
  const hasAuthorizationHeader = Boolean(authHeader);
  const startsWithBearer = Boolean(authHeader?.startsWith("Bearer "));
  const tokenLength = startsWithBearer ? authHeader.slice("Bearer ".length).length : 0;
  console.log(JSON.stringify({ type: "auth_debug", hasAuthorizationHeader, startsWithBearer, tokenLength }));
}

function extractBearerToken(req) {
  logAuthorizationDebug(req);
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_request",
      errorDescription: "Missing Authorization header.",
      details: { debug: "missing_authorization_header" }
    });
  }
  if (!authHeader.startsWith("Bearer ")) {
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_request",
      errorDescription: 'Authorization header must start with "Bearer ".',
      details: { debug: "bad_authorization_scheme" }
    });
  }
  return authHeader.slice("Bearer ".length);
}

// The shared environment token is every user of this server querying the deployer's
// own CallRail account, so it is off unless someone deliberately turns it on for a
// single-tenant deployment.
// This server hands every user the same Google Ads developer token and, optionally, the
// same CallRail key. Those are metered and owned centrally, so who may connect has to be
// controlled here rather than left to whoever finds the URL.
const DEFAULT_ALLOWED_DOMAINS = ["cibirix.com"];
// Partner domains are shared with people who are not on the team, so an address there
// must also identify itself as one of ours.
const DEFAULT_PARTNER_DOMAINS = ["sensei.com", "senseidigita.com", "shelterscore.com"];
const DEFAULT_EMAIL_MARKERS = ["cibirix", "cbx"];

function parseListEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return String(raw).split(/[,\s]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
}

function getAllowedDomains() {
  return parseListEnv("ALLOWED_EMAIL_DOMAINS", DEFAULT_ALLOWED_DOMAINS);
}

function getPartnerDomains() {
  return parseListEnv("ALLOWED_PARTNER_DOMAINS", DEFAULT_PARTNER_DOMAINS);
}

function getEmailMarkers() {
  return parseListEnv("ALLOWED_EMAIL_MARKERS", DEFAULT_EMAIL_MARKERS);
}

function isAllowlistEnforced() {
  if (["1", "true", "yes"].includes(String(process.env.ACCESS_ALLOWLIST_DISABLED || "").toLowerCase())) {
    return false;
  }
  return getAllowedDomains().length > 0 || getPartnerDomains().length > 0;
}

function splitEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  // Exactly one @ and a hostname-shaped domain. Splitting on the last @ alone would let
  // "x@evil.com?@cibirix.com" read as the cibirix.com domain.
  if (!/^[^s@]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value)) return null;
  const at = value.lastIndexOf("@");
  return { local: value.slice(0, at), domain: value.slice(at + 1), email: value };
}

// Two ways in: the address is on a domain we own outright, or it is on a partner domain
// and the local part carries one of our markers.
function isEmailAllowed(email) {
  if (!isAllowlistEnforced()) return { allowed: true, reason: "allowlist_disabled" };
  const parts = splitEmail(email);
  if (!parts) return { allowed: false, reason: "no_email" };
  if (getAllowedDomains().includes(parts.domain)) {
    return { allowed: true, reason: "allowed_domain", domain: parts.domain };
  }
  if (getPartnerDomains().includes(parts.domain)) {
    const marker = getEmailMarkers().find((m) => parts.local.includes(m));
    if (marker) return { allowed: true, reason: "partner_domain_with_marker", domain: parts.domain, marker };
    return { allowed: false, reason: "partner_domain_without_marker", domain: parts.domain };
  }
  return { allowed: false, reason: "domain_not_allowed", domain: parts.domain };
}

// The id_token comes straight back from Google's token endpoint over TLS in response to
// a request carrying our client secret, so the payload is read directly.
function readEmailFromIdToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload?.email ? String(payload.email).toLowerCase() : null;
  } catch {
    return null;
  }
}

function describeAllowlist() {
  return {
    enforced: isAllowlistEnforced(),
    allowedDomains: getAllowedDomains(),
    partnerDomains: getPartnerDomains(),
    emailMarkers: getEmailMarkers()
  };
}

function allowsSharedCallRailToken() {
  return ["1", "true", "yes"].includes(String(process.env.CALLRAIL_ALLOW_SHARED_TOKEN || "").toLowerCase());
}

function getSharedCallRailToken() {
  return allowsSharedCallRailToken() ? (process.env.CALLRAIL_API_TOKEN || null) : null;
}

function requireCallRailKey(apiKey) {
  const key = apiKey || getSharedCallRailToken();
  if (!key) {
    throw new Error("No CallRail API key on this session. Connect one at /auth/callrail.");
  }
  return key;
}

// Only ever show enough of a key to recognise it.
function maskCallRailKey(apiKey) {
  const value = String(apiKey || "");
  if (value.length <= 8) return value ? "*".repeat(value.length) : "";
  return `${value.slice(0, 4)}${"*".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

function requireGoogleAdsDeveloperToken() {
  return requireEnv("GOOGLE_ADS_DEVELOPER_TOKEN");
}

function getGoogleAdsLoginCustomerId(value) {
  const candidate = value || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  return candidate ? normalizeGoogleAdsCustomerId(candidate) : undefined;
}

function normalizeCallRailPath(path) {
  const candidate = String(path || "").trim();
  if (!candidate) throw new Error("CallRail path is required.");
  if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
    const url = new URL(candidate);
    const expectedPrefix = new URL(getCallRailBaseUrl()).origin;
    if (url.origin !== expectedPrefix) {
      throw new Error("CallRail absolute URLs must match CALLRAIL_API_BASE_URL.");
    }
    return url.toString();
  }
  const normalized = candidate.startsWith("/") ? candidate : `/${candidate}`;
  if (!normalized.endsWith(".json")) {
    throw new Error('CallRail paths must end with ".json".');
  }
  return normalized;
}

function appendQueryParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === "") continue;
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
  );
}

function getNestedValue(source, path) {
  return String(path || "").split(".").filter(Boolean).reduce((current, segment) => current?.[segment], source);
}

function toCamelCaseSegment(segment) {
  return segment.replace(/_([a-z0-9])/g, (_match, character) => character.toUpperCase());
}

// The Google Ads REST API returns lowerCamelCase JSON keys (metrics.costMicros) while
// GAQL field paths are snake_case (metrics.cost_micros). Resolve either spelling.
function getGoogleAdsValue(source, path) {
  return String(path || "").split(".").filter(Boolean).reduce((current, segment) => {
    if (current === undefined || current === null) return undefined;
    const direct = current[segment];
    if (direct !== undefined) return direct;
    return current[toCamelCaseSegment(segment)];
  }, source);
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function microsToStandardCurrency(value) {
  const numeric = toNumber(value);
  return numeric === undefined ? undefined : numeric / 1_000_000;
}

function formatDateForApi(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function resolveDateWindow({ startDate, endDate, lookbackDays = 30 }) {
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return {
    startDate: formatDateForApi(start),
    endDate: formatDateForApi(end)
  };
}

function buildNormalizedRecord({ platform, preset, entityType, sourcePrimaryKey, dimensions = {}, metrics = {}, sourceContext = {} }) {
  return {
    schemaVersion: NORMALIZED_MARKETING_SCHEMA.version,
    platform,
    preset,
    entityType,
    sourcePrimaryKey: sourcePrimaryKey || null,
    dimensions: compactObject(dimensions),
    metrics: compactObject(metrics),
    sourceContext: compactObject(sourceContext)
  };
}

function mapGa4ReportRows(body) {
  const dimensionHeaders = body?.dimensionHeaders || [];
  const metricHeaders = body?.metricHeaders || [];
  return (body?.rows || []).map((row) => {
    const dimensions = Object.fromEntries(
      dimensionHeaders.map((header, index) => [header.name, row.dimensionValues?.[index]?.value])
    );
    const metrics = Object.fromEntries(
      metricHeaders.map((header, index) => [header.name, row.metricValues?.[index]?.value])
    );
    return { dimensions, metrics };
  });
}

function buildSearchConsoleRowObjects(body, dimensions = []) {
  return (body?.rows || []).map((row) => {
    const mappedDimensions = Object.fromEntries(dimensions.map((dimension, index) => [dimension, row.keys?.[index]]));
    return {
      ...mappedDimensions,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position
    };
  });
}

function saveSession(sessionId, session) {
  const record = {
    ...session,
    updatedAt: Date.now(),
    sessionExpiresAt: session.sessionExpiresAt || Date.now() + SESSION_TTL_MS
  };
  sessionStore.set(sessionId, record);
  return record;
}

function getSession(sessionId) {
  const session = sessionStore.get(sessionId);
  if (!session) return null;
  if (session.sessionExpiresAt && Number(session.sessionExpiresAt) <= Date.now()) {
    sessionStore.delete(sessionId);
    return null;
  }
  return session;
}

function deleteSession(sessionId) {
  sessionStore.delete(sessionId);
}

// A session may hold Google credentials, Meta credentials, or both, so these
// sections are emitted only when the provider is actually connected.
function sealGoogleSection(google) {
  if (!google?.refreshToken) return undefined;
  return {
    refreshToken: google.refreshToken,
    scope: google.scope,
    tokenType: google.tokenType || "Bearer",
    // Kept so access can be re-checked on every call, which is what makes removing
    // someone from the allowlist take effect immediately rather than in 30 days.
    email: google.email || null
  };
}

function sealMetaSection(meta) {
  if (!meta?.accessToken) return undefined;
  return {
    accessToken: meta.accessToken,
    tokenType: meta.tokenType || "bearer",
    expiresAt: meta.expiresAt || null,
    scope: meta.scope,
    userId: meta.userId || null
  };
}

function sealCallRailSection(callrail) {
  if (!callrail?.apiKey) return undefined;
  return {
    apiKey: callrail.apiKey,
    accountId: callrail.accountId || null,
    accountName: callrail.accountName || null,
    connectedAt: callrail.connectedAt || null
  };
}

function mintAccessToken(req, payload) {
  return encryptJson({
    typ: "mcp_access_token",
    iss: getBaseUrl(req),
    aud: payload.resource,
    resource: payload.resource,
    sessionId: payload.sessionId,
    scope: payload.scope,
    iat: Date.now(),
    exp: Date.now() + ACCESS_TOKEN_TTL_MS,
    google: sealGoogleSection(payload.google),
    meta: sealMetaSection(payload.meta),
    callrail: sealCallRailSection(payload.callrail)
  });
}

function mintRefreshToken(req, payload) {
  return encryptJson({
    typ: "mcp_refresh_token",
    iss: getBaseUrl(req),
    aud: payload.resource,
    resource: payload.resource,
    sessionId: payload.sessionId,
    scope: payload.scope,
    iat: Date.now(),
    exp: Date.now() + REFRESH_TOKEN_TTL_MS,
    google: sealGoogleSection(payload.google),
    meta: sealMetaSection(payload.meta),
    callrail: sealCallRailSection(payload.callrail)
  });
}

function getRequestedResource(req, fallback) {
  const requested = req.query.resource || req.query.audience || req.body?.resource || req.body?.audience;
  return requested ? String(requested) : fallback;
}

async function refreshGoogleTokensIfNeeded(req, session) {
  if (!session?.refreshToken) {
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_token",
      errorDescription: "No valid session.",
      details: { debug: "no_valid_session" }
    });
  }
  const expiresAt = Number(session.expiryDate || 0);
  const isFresh = session.accessToken && expiresAt && expiresAt - Date.now() > 60_000;
  if (isFresh) return session;
  const oauthClient = createOauthClient(req);
  oauthClient.setCredentials({ refresh_token: session.refreshToken });
  try {
    const { credentials } = await oauthClient.refreshAccessToken();
    return saveSession(session.sessionId, {
      ...session,
      accessToken: credentials.access_token,
      refreshToken: session.refreshToken,
      expiryDate: credentials.expiry_date,
      scope: credentials.scope || session.scope,
      tokenType: credentials.token_type || session.tokenType || "Bearer"
    });
  } catch (error) {
    const permanent = isPermanentGoogleAuthFailure(error);
    console.log(JSON.stringify({
      type: "google_refresh_failed",
      grant: "per_request",
      permanent,
      message: error instanceof Error ? error.message : String(error)
    }));
    // Dropping the session on a transient failure is what turns one bad minute at
    // Google into a re-login prompt, so only a dead grant clears it. A 503 tells the
    // client to retry; a 401 would tell it to start OAuth over.
    if (!permanent) {
      throw buildAuthError({
        httpStatus: 503,
        error: "temporarily_unavailable",
        errorDescription: "Could not reach Google to refresh credentials. Retry shortly.",
        details: { debug: "google_refresh_transient" }
      });
    }
    if (session.sessionId) {
      deleteSession(session.sessionId);
    }
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_token",
      errorDescription: "Google access was revoked or expired. Reconnect to continue.",
      details: { debug: "google_refresh_failed", google_error: error instanceof Error ? error.message : String(error) }
    });
  }
}

async function verifyMcpAccessToken(req, requiredScopes = []) {
  if (req.mcpAuth?.verifiedScopesKey === requiredScopes.join(" ")) return req.mcpAuth;
  const rawToken = extractBearerToken(req);
  let payload;
  try {
    payload = decryptJson(rawToken);
  } catch {
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_token",
      errorDescription: "Malformed token.",
      details: { debug: "malformed_token" }
    });
  }
  const issuer = getBaseUrl(req);
  const resource = getResourceUrl(req);
  if (payload.typ !== "mcp_access_token") {
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_token",
      errorDescription: "Token is not a Vercel-issued MCP access token.",
      details: { debug: "wrong_token_type", token_type: payload.typ || null }
    });
  }
  if (!urlsMatch(payload.iss, issuer)) {
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_token",
      errorDescription: "Bad issuer.",
      details: { debug: "bad_issuer", expected_issuer: issuer, actual_issuer: payload.iss || null }
    });
  }
  const tokenAudience = payload.resource || payload.aud;
  if (!resourcesMatch(tokenAudience, resource)) {
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_token",
      errorDescription: "Bad audience/resource.",
      details: { debug: "bad_audience_resource", expected_resource: resource, actual_resource: tokenAudience || null }
    });
  }
  if (!payload.exp || Number(payload.exp) <= Date.now()) {
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_token",
      errorDescription: "Expired token.",
      details: { debug: "expired_token", expired_at: payload.exp || null }
    });
  }
  const sessionId = payload.sessionId;
  let session = sessionId ? getSession(sessionId) : null;
  // Serverless instances do not share the in-memory session cache, so rebuild the
  // session from the credentials sealed inside the access token when it is missing.
  if (sessionId && (payload.google?.refreshToken || payload.meta?.accessToken || payload.callrail?.apiKey)) {
    session = saveSession(sessionId, {
      ...(session || {}),
      sessionId,
      refreshToken: session?.refreshToken || payload.google?.refreshToken || null,
      accessToken: session?.refreshToken ? session.accessToken : null,
      expiryDate: session?.refreshToken ? session.expiryDate : 0,
      scope: session?.scope || buildSessionScope({
        googleScope: payload.google?.scope,
        metaScope: payload.meta?.scope,
          hasCallRail: Boolean(session?.callrail?.apiKey || payload.callrail?.apiKey),
        fallbackScope: payload.scope
      }),
      tokenType: payload.google?.tokenType || "Bearer",
      email: session?.email || payload.google?.email || null,
      meta: session?.meta || (payload.meta?.accessToken ? payload.meta : null),
      callrail: session?.callrail || (payload.callrail?.apiKey ? payload.callrail : null),
      sessionExpiresAt: Date.now() + SESSION_TTL_MS
    });
  }
  if (!session) {
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_token",
      errorDescription: "No valid session.",
      details: { debug: "no_valid_session" }
    });
  }
  // Re-checked per request rather than only at connect, so taking someone off the
  // allowlist cuts them off now instead of when their token eventually expires.
  const sessionEmail = session.email || payload.google?.email || null;
  const sessionAccess = isEmailAllowed(sessionEmail);
  if (!sessionAccess.allowed) {
    if (sessionId) deleteSession(sessionId);
    throw buildAuthError({
      httpStatus: 403,
      error: "access_denied",
      errorDescription: sessionAccess.reason === "no_email"
        ? "This connection predates access control. Reconnect to continue."
        : "This account is not permitted to use this server.",
      details: { debug: "not_on_allowlist", reason: sessionAccess.reason }
    });
  }

  const grantedScopes = normalizeScopes(session.scope || payload.scope);
  if (!hasScopes(grantedScopes, requiredScopes)) {
    throw buildAuthError({
      httpStatus: 403,
      error: "insufficient_scope",
      errorDescription: "Missing scopes.",
      details: { debug: "missing_scopes", required_scopes: requiredScopes, granted_scopes: grantedScopes }
    });
  }

  // Only touch a provider the caller actually needs, so a Meta-only session is not
  // rejected for having no Google refresh token and vice versa.
  const needsGoogle = scopesInclude(requiredScopes, GOOGLE_SCOPES);
  const needsMeta = scopesInclude(requiredScopes, META_SCOPES);
  const needsCallRail = scopesInclude(requiredScopes, CALLRAIL_SCOPES);

  // A shared environment key would hand every user of this server the deployer's own
  // call records, so it stands in only when someone has explicitly opted into it.
  const sessionCallRail = session.callrail || (payload.callrail?.apiKey ? payload.callrail : null);
  const sharedCallRailToken = getSharedCallRailToken();
  const callRailCredentials = sessionCallRail?.apiKey
    ? { ...sessionCallRail, source: "session" }
    : sharedCallRailToken
      ? { apiKey: sharedCallRailToken, accountId: null, accountName: null, source: "shared_environment" }
      : null;
  if (needsCallRail && !callRailCredentials?.apiKey) {
    throw buildAuthError({
      httpStatus: 401,
      error: "invalid_token",
      errorDescription: "No CallRail API key on this session. Connect one at /auth/callrail.",
      details: { debug: "no_callrail_credentials" }
    });
  }

  const metaCredentials = session.meta || (payload.meta?.accessToken ? payload.meta : null);
  if (needsMeta) {
    if (!metaCredentials?.accessToken) {
      throw buildAuthError({
        httpStatus: 401,
        error: "invalid_token",
        errorDescription: "No Meta credentials on this session. Authorize at /auth/meta/start.",
        details: { debug: "no_meta_credentials" }
      });
    }
    if (metaCredentials.expiresAt && Number(metaCredentials.expiresAt) <= Date.now()) {
      throw buildAuthError({
        httpStatus: 401,
        error: "invalid_token",
        errorDescription: "Meta access token expired. Meta has no refresh tokens, so re-authorize at /auth/meta/start.",
        details: { debug: "meta_token_expired", expired_at: metaCredentials.expiresAt }
      });
    }
  }

  const googleCredentials = needsGoogle || session.refreshToken
    ? await refreshGoogleTokensIfNeeded(req, session)
    : null;

  req.mcpAuth = {
    issuer,
    resource,
    scope: grantedScopes.join(" "),
    scopes: grantedScopes,
    googleCredentials,
    metaCredentials,
    callRailCredentials,
    sessionId,
    verifiedScopesKey: requiredScopes.join(" ")
  };
  return req.mcpAuth;
}

async function exchangeGoogleRefreshToken(req, refreshToken) {
  const oauthClient = createOauthClient(req);
  oauthClient.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauthClient.refreshAccessToken();
  return credentials;
}

async function callGoogleApi(url, accessToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const rawBody = await response.text();
  let parsedBody = rawBody;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {}
  console.log(JSON.stringify({ type: "google_api_debug", url, status: response.status, body: parsedBody }));
  return { ok: response.ok, status: response.status, body: parsedBody };
}

async function callCallRailApi(pathOrUrl, query = {}, apiKey) {
  const url = pathOrUrl.startsWith("http")
    ? new URL(pathOrUrl)
    : new URL(`${getCallRailBaseUrl()}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`);
  appendQueryParams(url, query);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Token token="${requireCallRailKey(apiKey)}"`,
      Accept: "application/json"
    }
  });
  const rawBody = await response.text();
  let parsedBody = rawBody;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {}
  console.log(JSON.stringify({ type: "callrail_api_debug", url: url.toString(), status: response.status, body: parsedBody }));
  return { ok: response.ok, status: response.status, body: parsedBody };
}

async function callGoogleAdsApi(path, accessToken, options = {}) {
  const url = path.startsWith("http") ? path : `https://googleads.googleapis.com/${getGoogleAdsApiVersion()}/${path.replace(/^\/+/, "")}`;
  const response = await fetch(url, {
    method: options.method || "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": requireGoogleAdsDeveloperToken(),
      ...(getGoogleAdsLoginCustomerId(options.loginCustomerId) ? { "login-customer-id": getGoogleAdsLoginCustomerId(options.loginCustomerId) } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const rawBody = await response.text();
  let parsedBody = rawBody;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {}
  console.log(JSON.stringify({ type: "google_ads_api_debug", url, status: response.status, body: parsedBody }));
  return { ok: response.ok, status: response.status, body: parsedBody };
}

function buildToolResult(payload, isError = false, meta) {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
    ...(payload && typeof payload === "object" ? { structuredContent: payload } : {}),
    ...(isError ? { isError: true } : {}),
    ...(meta ? { _meta: meta } : {})
  };
}

function toGoogleDebugPayload(response) {
  return response.ok ? response.body : { status: response.status, error: response.body };
}

function toToolErrorPayload(error) {
  if (error?.oauthError) return formatAuthErrorResponse(error);
  return { error: "tool_execution_failed", error_description: error instanceof Error ? error.message : String(error) };
}

function shouldEmitAuthChallenge(error) {
  return ["missing_authorization_header", "bad_authorization_scheme", "no_valid_session", "google_refresh_failed", "missing_scopes"].includes(error?.details?.debug);
}

async function withVerifiedToolAuth(req, requiredScopes, handler) {
  try {
    const auth = await verifyMcpAccessToken(req, requiredScopes);
    return await handler(auth);
  } catch (error) {
    return buildToolResult(
      toToolErrorPayload(error),
      true,
      shouldEmitAuthChallenge(error) ? { "mcp/www_authenticate": getAuthenticateHeader(error) } : undefined
    );
  }
}

// CallRail tools used to run with no auth check at all, against a shared environment
// key, which meant any holder of any valid MCP token could read the deployer's own call
// records. They now verify the token like every other provider and use the key that
// belongs to the calling session.
async function withCallRailTool(req, toolName, handler) {
  return withVerifiedToolAuth(req, CALLRAIL_TOOL_SCOPES[toolName] || [CALLRAIL_SCOPE], async ({ callRailCredentials }) => {
    try {
      return await handler({
        apiKey: callRailCredentials.apiKey,
        credentials: callRailCredentials
      });
    } catch (error) {
      return buildToolResult(toToolErrorPayload(error), true);
    }
  });
}

const GOOGLE_ADS_MAX_PAGE_SIZE = 10000;

function shiftDays(dateString, days) {
  const base = new Date(`${dateString}T00:00:00Z`);
  return formatDateForApi(new Date(base.getTime() + days * 24 * 60 * 60 * 1000));
}

function daysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`).getTime();
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

function buildGoogleAdsPresetQuery(params) {
  const preset = params.preset;
  const definition = GOOGLE_ADS_PRESET_DEFINITIONS[preset];
  if (!definition) throw new Error(`Unsupported Google Ads preset: ${preset}`);

  if (definition.requiresCampaignId && !params.campaignId) {
    throw new Error(`Google Ads preset "${preset}" requires campaignId. Google rejects this report without a campaign filter.`);
  }
  if (params.includeImpressionShare && !definition.supportsImpressionShare && preset !== "impression_share") {
    throw new Error(`Google Ads preset "${preset}" does not support impression share metrics. Use the impression_share preset, or one of: campaign_performance, ad_group_performance, keyword_performance.`);
  }
  if (params.includeQualityScore && !definition.supportsQualityScore && preset !== "quality_score") {
    throw new Error(`Google Ads preset "${preset}" does not support Quality Score fields. Use the quality_score preset or keyword_performance.`);
  }

  let { startDate, endDate } = resolveDateWindow(params);
  const notes = [];

  if (definition.maxLookbackDays && daysBetween(startDate, endDate) > definition.maxLookbackDays) {
    startDate = shiftDays(endDate, -definition.maxLookbackDays);
    notes.push(`Google limits ${preset} to the last ${definition.maxLookbackDays} days; startDate was clamped to ${startDate}.`);
  }
  if (definition.singleDay) {
    startDate = endDate;
    notes.push(`${preset} requires a single-day filter; using ${endDate}.`);
  }

  const requestedLimit = Number(params.limit || 100);
  const cappedLimit = definition.maxLimit ? Math.min(requestedLimit, definition.maxLimit) : requestedLimit;
  if (cappedLimit !== requestedLimit) {
    notes.push(`Google caps ${preset} at ${definition.maxLimit} rows; limit was reduced from ${requestedLimit}.`);
  }
  const limit = cappedLimit;
  const pageSize = Math.min(limit, GOOGLE_ADS_MAX_PAGE_SIZE);
  if (pageSize !== limit) {
    notes.push(`Google caps pageSize at ${GOOGLE_ADS_MAX_PAGE_SIZE}; page through the rest with pageToken.`);
  }

  const includeDailyBreakdown = params.includeDailyBreakdown !== false;
  const usesDateSegment = definition.timeSeries === true;
  const dailyField = usesDateSegment && includeDailyBreakdown ? ", segments.date" : "";

  const whereClauses = [];
  if (definition.dateField) {
    whereClauses.push(`${definition.dateField} >= '${startDate} 00:00:00'`);
    whereClauses.push(`${definition.dateField} <= '${endDate} 23:59:59'`);
  } else if (usesDateSegment) {
    whereClauses.push(definition.singleDay
      ? `segments.date = '${endDate}'`
      : `segments.date BETWEEN '${startDate}' AND '${endDate}'`);
  }
  if (params.campaignId) {
    const campaignField = preset === "pmax_search_terms" ? "campaign_search_term_insight.campaign_id" : "campaign.id";
    whereClauses.push(`${campaignField} = ${String(params.campaignId).replace(/[^0-9]/g, "")}`);
  }

  const optionalImpressionShare = params.includeImpressionShare ? `, ${GOOGLE_ADS_IMPRESSION_SHARE_METRICS}` : "";
  const optionalQualityScore = params.includeQualityScore ? `, ${GOOGLE_ADS_QUALITY_SCORE_FIELDS}` : "";

  const queries = {
    campaign_performance: {
      select: `campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type, customer.currency_code${dailyField}, ${GOOGLE_ADS_EXTENDED_METRICS}${optionalImpressionShare}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    ad_group_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, ad_group.type, customer.currency_code${dailyField}, ${GOOGLE_ADS_EXTENDED_METRICS}${optionalImpressionShare}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    keyword_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.effective_cpc_bid_micros, customer.currency_code${dailyField}, ${GOOGLE_ADS_EXTENDED_METRICS}${optionalImpressionShare}${optionalQualityScore}`,
      defaultOrder: "metrics.clicks DESC"
    },
    search_terms: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, search_term_view.search_term, search_term_view.status, segments.search_term_match_type${dailyField}, ${GOOGLE_ADS_EXTENDED_METRICS}`,
      defaultOrder: "metrics.clicks DESC"
    },
    asset_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, asset.id, asset.name, asset.type, asset.text_asset.text, ad_group_ad_asset_view.field_type, ad_group_ad_asset_view.performance_label${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.impressions DESC"
    },
    conversions_by_campaign: {
      select: `campaign.id, campaign.name, campaign.status, customer.currency_code${dailyField}, ${GOOGLE_ADS_EXTENDED_METRICS}`,
      defaultOrder: "metrics.conversions DESC"
    },
    ad_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.name, ad_group_ad.status, ad_group_ad.ad_strength, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.policy_summary.approval_status${dailyField}, ${GOOGLE_ADS_EXTENDED_METRICS}`,
      defaultOrder: "metrics.impressions DESC"
    },
    impression_share: {
      select: `campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type${dailyField}, metrics.impressions, metrics.clicks, metrics.cost_micros, ${GOOGLE_ADS_IMPRESSION_SHARE_METRICS}`,
      defaultOrder: "metrics.impressions DESC"
    },
    quality_score: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ${GOOGLE_ADS_QUALITY_SCORE_FIELDS}`,
      defaultOrder: "ad_group_criterion.quality_info.quality_score ASC"
    },
    shopping_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, segments.product_item_id, segments.product_title, segments.product_brand, segments.product_type_l1, segments.product_type_l2, segments.product_condition, segments.product_channel, segments.product_country${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    product_group_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.listing_group.type, ad_group_criterion.status, ad_group_criterion.cpc_bid_micros${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    pmax_asset_groups: {
      select: `campaign.id, campaign.name, asset_group.id, asset_group.name, asset_group.status, asset_group.ad_strength${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    pmax_search_terms: {
      select: `campaign_search_term_insight.id, campaign_search_term_insight.category_label${dailyField}, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value`,
      defaultOrder: "metrics.impressions DESC"
    },
    geo_performance: {
      select: `campaign.id, campaign.name, geographic_view.country_criterion_id, geographic_view.location_type, segments.geo_target_country, segments.geo_target_region, segments.geo_target_city${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    device_performance: {
      select: `campaign.id, campaign.name, campaign.advertising_channel_type, segments.device${dailyField}, ${GOOGLE_ADS_EXTENDED_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    ad_schedule_performance: {
      select: `campaign.id, campaign.name, segments.day_of_week, segments.hour${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    demographics_age: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.age_range.type, ad_group_criterion.status${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    demographics_gender: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.gender.type, ad_group_criterion.status${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    audience_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.display_name, ad_group_criterion.status${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    placement_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, group_placement_view.display_name, group_placement_view.placement, group_placement_view.placement_type, group_placement_view.target_url${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    conversion_actions: {
      select: `campaign.id, campaign.name, segments.conversion_action_name, segments.conversion_action_category${dailyField}, ${GOOGLE_ADS_CONVERSION_ONLY_METRICS}`,
      defaultOrder: "metrics.all_conversions DESC"
    },
    landing_page_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, landing_page_view.unexpanded_final_url${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    expanded_landing_page_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, expanded_landing_page_view.expanded_final_url${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    campaign_budgets: {
      select: `campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.delivery_method, campaign_budget.explicitly_shared, campaign_budget.period, campaign_budget.status, campaign_budget.recommended_budget_amount_micros, customer.currency_code${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    bidding_strategies: {
      select: `bidding_strategy.id, bidding_strategy.name, bidding_strategy.type, bidding_strategy.status, bidding_strategy.campaign_count, bidding_strategy.effective_currency_code${dailyField}, ${GOOGLE_ADS_CORE_METRICS}`,
      defaultOrder: "metrics.cost_micros DESC"
    },
    video_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, video.id, video.title, video.duration_millis, video.channel_id${dailyField}, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.video_views, metrics.video_view_rate, metrics.average_cpv, metrics.video_quartile_p25_rate, metrics.video_quartile_p50_rate, metrics.video_quartile_p75_rate, metrics.video_quartile_p100_rate, metrics.conversions, metrics.conversions_value`,
      defaultOrder: "metrics.impressions DESC"
    },
    call_performance: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, call_view.call_duration_seconds, call_view.call_status, call_view.call_tracking_display_location, call_view.caller_area_code, call_view.caller_country_code, call_view.start_call_date_time, call_view.end_call_date_time, call_view.type${dailyField}`,
      defaultOrder: null
    },
    account_overview: {
      select: `customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.optimization_score, customer.auto_tagging_enabled, customer.manager, customer.test_account, customer.status${dailyField}, ${GOOGLE_ADS_EXTENDED_METRICS}`,
      defaultOrder: null
    },
    negative_keywords: {
      select: "campaign.id, campaign.name, campaign.status, campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type",
      defaultOrder: null,
      extraWhere: ["campaign_criterion.negative = TRUE"]
    },
    shared_set_negative_keywords: {
      select: "shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_criterion.criterion_id, shared_criterion.type, shared_criterion.keyword.text, shared_criterion.keyword.match_type",
      defaultOrder: null
    },
    change_history: {
      select: "change_event.change_date_time, change_event.change_resource_type, change_event.change_resource_name, change_event.changed_fields, change_event.client_type, change_event.user_email, change_event.resource_change_operation, change_event.campaign, change_event.ad_group, change_event.old_resource, change_event.new_resource",
      defaultOrder: "change_event.change_date_time DESC"
    },
    recommendations: {
      select: "recommendation.resource_name, recommendation.type, recommendation.campaign, recommendation.dismissed, recommendation.impact.base_metrics.impressions, recommendation.impact.base_metrics.clicks, recommendation.impact.base_metrics.cost_micros, recommendation.impact.base_metrics.conversions, recommendation.impact.potential_metrics.impressions, recommendation.impact.potential_metrics.clicks, recommendation.impact.potential_metrics.cost_micros, recommendation.impact.potential_metrics.conversions",
      defaultOrder: null
    },
    experiments: {
      select: "experiment.resource_name, experiment.experiment_id, experiment.name, experiment.description, experiment.type, experiment.status, experiment.start_date, experiment.end_date",
      defaultOrder: null
    },
    click_view: {
      select: `campaign.id, campaign.name, ad_group.id, ad_group.name, click_view.gclid, click_view.ad_group_ad, click_view.keyword_info.text, click_view.page_number, segments.click_type, segments.device, segments.ad_network_type${dailyField}, metrics.clicks`,
      defaultOrder: null
    }
  };

  const shape = queries[preset];
  if (!shape) throw new Error(`Unsupported Google Ads preset: ${preset}`);

  const callerWhere = Array.isArray(params.extraWhereClauses) ? params.extraWhereClauses.filter(Boolean) : [];
  const allWhere = [...whereClauses, ...(shape.extraWhere || []), ...callerWhere];
  const whereSql = allWhere.length ? ` WHERE ${allWhere.join(" AND ")}` : "";
  const orderTarget = params.orderBy || shape.defaultOrder;
  const orderBySql = orderTarget ? ` ORDER BY ${orderTarget}` : "";
  const limitSql = limit > 0 ? ` LIMIT ${limit}` : "";
  const query = `SELECT ${shape.select} FROM ${definition.resource}${whereSql}${orderBySql}${limitSql}`;

  return {
    entityType: definition.entityType,
    resource: definition.resource,
    timeSeries: definition.timeSeries === true,
    query,
    dateRange: definition.timeSeries || definition.dateField ? { startDate, endDate } : null,
    limit,
    pageSize,
    notes
  };
}

// GA4 renamed "conversions" to "keyEvents". keyEvents is the current metric; the legacy
// name still resolves on most properties, so it stays available as an explicit opt-in.
const GA4_DEFAULT_CONVERSION_METRIC = "keyEvents";

function ga4Dimensions(...names) {
  return names.filter(Boolean).map((name) => ({ name }));
}

function ga4Metrics(...names) {
  return names.filter(Boolean).map((name) => ({ name }));
}

function buildGa4PresetRequest(params) {
  const definition = GA4_PRESET_DEFINITIONS[params.preset];
  if (!definition) throw new Error(`Unsupported GA4 preset: ${params.preset}`);

  const dateRange = resolveDateWindow(params);
  const conv = params.conversionMetric || GA4_DEFAULT_CONVERSION_METRIC;
  const notes = [];
  if (conv === "conversions") {
    notes.push("Using the legacy 'conversions' metric. GA4 renamed it to 'keyEvents'; prefer keyEvents unless this property rejects it.");
  }

  const includeDate = params.includeDailyBreakdown === true;
  const dateDimension = includeDate ? "date" : null;

  const common = {
    propertyId: params.propertyId,
    dateRanges: [{ startDate: dateRange.startDate, endDate: dateRange.endDate }],
    limit: params.limit ? String(params.limit) : undefined,
    offset: params.offset ? String(params.offset) : undefined,
    dimensionFilter: params.dimensionFilter,
    metricFilter: params.metricFilter,
    keepEmptyRows: params.keepEmptyRows,
    orderBys: params.orderBys
  };

  const shapes = {
    channels: {
      dimensions: ga4Dimensions("sessionDefaultChannelGroup", dateDimension),
      metrics: ga4Metrics("sessions", "totalUsers", "engagedSessions", "engagementRate", conv, "totalRevenue")
    },
    traffic_acquisition: {
      dimensions: ga4Dimensions("sessionDefaultChannelGroup", "sessionSource", "sessionMedium", dateDimension),
      metrics: ga4Metrics("sessions", "engagedSessions", "engagementRate", "averageSessionDuration", conv, "totalRevenue")
    },
    user_acquisition: {
      dimensions: ga4Dimensions("firstUserDefaultChannelGroup", "firstUserSource", "firstUserMedium", dateDimension),
      metrics: ga4Metrics("totalUsers", "newUsers", "engagedSessions", conv, "totalRevenue")
    },
    source_medium: {
      dimensions: ga4Dimensions("sessionSourceMedium", dateDimension),
      metrics: ga4Metrics("sessions", "totalUsers", "engagedSessions", conv, "totalRevenue")
    },
    campaigns: {
      dimensions: ga4Dimensions("sessionCampaignName", "sessionSourceMedium", dateDimension),
      metrics: ga4Metrics("sessions", "engagedSessions", conv, "totalRevenue")
    },
    google_ads_performance: {
      dimensions: ga4Dimensions("sessionGoogleAdsCampaignName", "sessionSourceMedium", dateDimension),
      metrics: ga4Metrics("sessions", "advertiserAdImpressions", "advertiserAdClicks", "advertiserAdCost", conv, "totalRevenue", "returnOnAdSpend")
    },
    landing_pages: {
      dimensions: ga4Dimensions("landingPagePlusQueryString", "sessionDefaultChannelGroup", dateDimension),
      metrics: ga4Metrics("sessions", "engagedSessions", "engagementRate", "bounceRate", conv, "totalRevenue")
    },
    pages_and_screens: {
      dimensions: ga4Dimensions("pagePath", "pageTitle", dateDimension),
      metrics: ga4Metrics("screenPageViews", "activeUsers", "userEngagementDuration", "eventCount", conv)
    },
    events: {
      dimensions: ga4Dimensions("eventName", dateDimension),
      metrics: ga4Metrics("eventCount", "totalUsers", "eventCountPerUser", "eventValue")
    },
    key_events: {
      dimensions: ga4Dimensions("eventName", dateDimension),
      metrics: ga4Metrics("eventCount", "totalUsers", conv, "totalRevenue")
    },
    ecommerce: {
      dimensions: ga4Dimensions("itemName", "itemCategory", dateDimension),
      metrics: ga4Metrics("itemsViewed", "itemsAddedToCart", "itemsPurchased", "itemRevenue")
    },
    item_performance: {
      dimensions: ga4Dimensions("itemName", "itemId", "itemBrand", "itemCategory", dateDimension),
      metrics: ga4Metrics("itemsViewed", "itemsAddedToCart", "itemsCheckedOut", "itemsPurchased", "itemRevenue")
    },
    item_list_performance: {
      dimensions: ga4Dimensions("itemListName", dateDimension),
      metrics: ga4Metrics("itemsViewed", "itemsAddedToCart", "itemsPurchased", "itemRevenue")
    },
    promotions: {
      dimensions: ga4Dimensions("itemPromotionName", dateDimension),
      metrics: ga4Metrics("itemsViewed", "itemsAddedToCart", "itemsPurchased", "itemRevenue")
    },
    ecommerce_funnel: {
      dimensions: ga4Dimensions("date"),
      metrics: ga4Metrics("itemsViewed", "addToCarts", "checkouts", "ecommercePurchases", "purchaseRevenue", "cartToViewRate", "purchaseToViewRate")
    },
    demographics: {
      dimensions: ga4Dimensions("country", "region", "city", dateDimension),
      metrics: ga4Metrics("sessions", "totalUsers", "newUsers", conv, "totalRevenue")
    },
    demographics_detail: {
      dimensions: ga4Dimensions("userAgeBracket", "userGender", "language", dateDimension),
      metrics: ga4Metrics("sessions", "totalUsers", conv, "totalRevenue")
    },
    technology: {
      dimensions: ga4Dimensions("deviceCategory", "operatingSystem", "browser", dateDimension),
      metrics: ga4Metrics("sessions", "totalUsers", "engagedSessions", "engagementRate", conv, "totalRevenue")
    },
    new_vs_returning: {
      dimensions: ga4Dimensions("newVsReturning", dateDimension),
      metrics: ga4Metrics("sessions", "totalUsers", "engagedSessions", "averageSessionDuration", conv, "totalRevenue")
    },
    audiences: {
      dimensions: ga4Dimensions("audienceName", dateDimension),
      metrics: ga4Metrics("sessions", "totalUsers", "engagedSessions", conv, "totalRevenue")
    },
    site_search: {
      dimensions: ga4Dimensions("searchTerm", dateDimension),
      metrics: ga4Metrics("eventCount", "totalUsers", conv)
    },
    engagement_overview: {
      dimensions: ga4Dimensions("date"),
      metrics: ga4Metrics("sessions", "engagedSessions", "engagementRate", "bounceRate", "averageSessionDuration", "screenPageViewsPerSession", "userEngagementDuration")
    },
    daily_trends: {
      dimensions: ga4Dimensions("date"),
      metrics: ga4Metrics("sessions", "totalUsers", "newUsers", "engagedSessions", conv, "totalRevenue")
    },
    attribution_breakdown: {
      dimensions: ga4Dimensions("sessionDefaultChannelGroup", "firstUserDefaultChannelGroup", dateDimension),
      metrics: ga4Metrics("sessions", "totalUsers", conv, "totalRevenue")
    }
  };

  const shape = shapes[params.preset];
  if (!shape) throw new Error(`Unsupported GA4 preset: ${params.preset}`);

  return {
    entityType: definition.entityType,
    conversionMetric: conv,
    notes,
    request: {
      ...common,
      dimensions: shape.dimensions,
      metrics: shape.metrics
    },
    dateRange
  };
}

function buildSearchConsolePresetRequest(params) {
  const definition = SEARCH_CONSOLE_PRESET_DEFINITIONS[params.preset];
  if (!definition) throw new Error(`Unsupported Search Console preset: ${params.preset}`);

  const dateRange = resolveDateWindow(params);
  const notes = [];
  let dimensions = [...definition.dimensions];

  if (params.preset === "date_trends" && params.secondaryDimension) {
    dimensions = ["date", params.secondaryDimension];
  }

  const dimensionFilterGroups = [...(params.dimensionFilterGroups || [])];
  if (params.preset === "branded_vs_non_branded") {
    if (!params.brandTerms?.length) {
      throw new Error("brandTerms is required for branded_vs_non_branded.");
    }
    const escapedTerms = params.brandTerms.map((term) => String(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const operator = params.brandMode === "non_branded" ? "excludingRegex" : "includingRegex";
    dimensionFilterGroups.push({
      groupType: "and",
      filters: [{
        dimension: "query",
        operator,
        expression: `(${escapedTerms.join("|")})`
      }]
    });
  }

  // Search Analytics caps a single response at 25000 rows; page with startRow beyond that.
  let rowLimit = params.rowLimit;
  if (rowLimit && rowLimit > SEARCH_CONSOLE_MAX_ROW_LIMIT) {
    notes.push(`Search Console caps rowLimit at ${SEARCH_CONSOLE_MAX_ROW_LIMIT}; reduced from ${rowLimit}. Page with startRow for more.`);
    rowLimit = SEARCH_CONSOLE_MAX_ROW_LIMIT;
  }
  if (params.preset === "striking_distance" && !rowLimit) {
    // The position filter is applied client-side, so pull a wide page before filtering.
    rowLimit = SEARCH_CONSOLE_MAX_ROW_LIMIT;
    notes.push("striking_distance filters on position after fetching, so rowLimit defaults to the 25000 maximum.");
  }

  const type = params.type || definition.type || undefined;
  if (definition.type && params.type && params.type !== definition.type) {
    notes.push(`Preset ${params.preset} is scoped to type "${definition.type}"; the supplied type "${params.type}" was used instead.`);
  }

  const postFilter = params.preset === "striking_distance"
    ? {
        minPosition: params.minPosition ?? 5,
        maxPosition: params.maxPosition ?? 20,
        minImpressions: params.minImpressions ?? 10
      }
    : null;

  return {
    entityType: definition.entityType,
    notes,
    postFilter,
    request: {
      siteUrl: params.siteUrl,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      dimensions,
      rowLimit,
      startRow: params.startRow,
      aggregationType: params.aggregationType,
      dataState: params.dataState,
      searchType: params.searchType,
      type,
      dimensionFilterGroups: dimensionFilterGroups.length ? dimensionFilterGroups : undefined
    },
    dateRange
  };
}

function applySearchConsolePostFilter(rows, postFilter) {
  if (!postFilter) return rows;
  return rows.filter((row) => {
    const position = toNumber(row.position);
    const impressions = toNumber(row.impressions) || 0;
    if (position === undefined) return false;
    return position >= postFilter.minPosition
      && position <= postFilter.maxPosition
      && impressions >= postFilter.minImpressions;
  });
}

function quoteMerchantLiteral(value) {
  return `'${String(value).replace(/'/g, "\\'")}'`;
}

// best_sellers_product_cluster_view only accepts a report_date that is the first
// day of a week (Monday) or of a month, depending on granularity.
function snapMerchantReportDate(date, granularity) {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  if (String(granularity).toUpperCase() === "MONTHLY") {
    return `${d.toISOString().slice(0, 7)}-01`;
  }
  const backToMonday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - backToMonday * 86400000).toISOString().slice(0, 10);
}

function buildMerchantPresetQuery(params) {
  const dateRange = resolveDateWindow(params);
  const limit = Number(params.limit || 100);
  const limitSql = limit > 0 ? ` LIMIT ${limit}` : "";
  const extra = Array.isArray(params.extraWhereClauses) ? params.extraWhereClauses.filter(Boolean) : [];
  const country = params.reportCountryCode ? String(params.reportCountryCode).toUpperCase() : null;
  const dailyField = params.includeDailyBreakdown === true ? ", date" : "";

  // The Merchant reports query language uses snake_case table and field names.
  // Responses come back camelCase, which is what normalizeMerchantPresetRows reads.
  function compose(select, table, where, orderBy) {
    const clauses = [...where.filter(Boolean), ...extra];
    const whereSql = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const orderSql = params.orderBy ? ` ORDER BY ${params.orderBy}` : (orderBy ? ` ORDER BY ${orderBy}` : "");
    return `SELECT ${select} FROM ${table}${whereSql}${orderSql}${limitSql}`;
  }

  const presets = {
    product_performance: () => compose(
      `offer_id, title, brand, category_l1, customer_country_code, marketing_method${dailyField}, clicks, impressions, click_through_rate, conversions, conversion_value, conversion_rate`,
      "product_performance_view",
      [
        `date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'`,
        params.marketingMethod ? `marketing_method = ${quoteMerchantLiteral(String(params.marketingMethod).toUpperCase())}` : null,
        country ? `customer_country_code = ${quoteMerchantLiteral(country)}` : null
      ],
      "clicks DESC"
    ),
    product_status: () => compose(
      `offer_id, id, title, brand, condition, availability, channel, feed_label, language_code, aggregated_reporting_context_status, click_potential, click_potential_rank${params.includeItemIssues === false ? "" : ", item_issues"}`,
      "product_view",
      [params.aggregatedStatus ? `aggregated_reporting_context_status = ${quoteMerchantLiteral(String(params.aggregatedStatus).toUpperCase())}` : null],
      null
    ),
    price_competitiveness: () => compose(
      "offer_id, id, title, brand, price, benchmark_price, report_country_code, category_l1",
      "price_competitiveness_product_view",
      [country ? `report_country_code = ${quoteMerchantLiteral(country)}` : null],
      null
    ),
    price_insights: () => compose(
      "offer_id, id, title, brand, price, suggested_price, effectiveness, predicted_clicks_change_fraction, predicted_impressions_change_fraction, predicted_conversions_change_fraction",
      "price_insights_product_view",
      [],
      null
    ),
    best_sellers: () => compose(
      "title, brand, rank, previous_rank, relative_demand, previous_relative_demand, relative_demand_change, inventory_status, brand_inventory_status, report_date, report_country_code, report_category_id, report_granularity",
      "best_sellers_product_cluster_view",
      [
        `report_date = '${snapMerchantReportDate(params.reportDate || dateRange.endDate, params.reportGranularity || "WEEKLY")}'`,
        `report_granularity = ${quoteMerchantLiteral(String(params.reportGranularity || "WEEKLY").toUpperCase())}`,
        country ? `report_country_code = ${quoteMerchantLiteral(country)}` : null,
        params.reportCategoryId ? `report_category_id = ${Number(params.reportCategoryId)}` : null
      ],
      "rank ASC"
    ),
    brand_performance: () => compose(
      `brand, customer_country_code, marketing_method${dailyField}, clicks, impressions, click_through_rate, conversions, conversion_value`,
      "product_performance_view",
      [
        `date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'`,
        params.marketingMethod ? `marketing_method = ${quoteMerchantLiteral(String(params.marketingMethod).toUpperCase())}` : null,
        country ? `customer_country_code = ${quoteMerchantLiteral(country)}` : null
      ],
      "clicks DESC"
    ),
    category_performance: () => compose(
      `category_l1, category_l2, customer_country_code, marketing_method${dailyField}, clicks, impressions, click_through_rate, conversions, conversion_value`,
      "product_performance_view",
      [
        `date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'`,
        params.marketingMethod ? `marketing_method = ${quoteMerchantLiteral(String(params.marketingMethod).toUpperCase())}` : null,
        country ? `customer_country_code = ${quoteMerchantLiteral(country)}` : null
      ],
      "clicks DESC"
    ),
    country_performance: () => compose(
      `customer_country_code, marketing_method${dailyField}, clicks, impressions, click_through_rate, conversions, conversion_value`,
      "product_performance_view",
      [
        `date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'`,
        params.marketingMethod ? `marketing_method = ${quoteMerchantLiteral(String(params.marketingMethod).toUpperCase())}` : null
      ],
      "clicks DESC"
    ),
    non_product_performance: () => compose(
      `date, customer_country_code, clicks, impressions, click_through_rate`,
      "non_product_performance_view",
      [
        `date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'`,
        country ? `customer_country_code = ${quoteMerchantLiteral(country)}` : null
      ],
      "clicks DESC"
    ),
    best_sellers_brands: () => compose(
      "brand, rank, previous_rank, relative_demand, previous_relative_demand, relative_demand_change, report_date, report_country_code, report_category_id, report_granularity",
      "best_sellers_brand_view",
      [
        `report_date = '${snapMerchantReportDate(params.reportDate || dateRange.endDate, params.reportGranularity || "WEEKLY")}'`,
        `report_granularity = ${quoteMerchantLiteral(String(params.reportGranularity || "WEEKLY").toUpperCase())}`,
        country ? `report_country_code = ${quoteMerchantLiteral(country)}` : null,
        params.reportCategoryId ? `report_category_id = ${Number(params.reportCategoryId)}` : null
      ],
      "rank ASC"
    ),
    competitive_visibility_benchmark: () => compose(
      "date, your_domain_visibility_trend, category_benchmark_visibility_trend, report_country_code, report_category_id, traffic_source",
      "competitive_visibility_benchmark_view",
      [
        `date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'`,
        country ? `report_country_code = ${quoteMerchantLiteral(country)}` : null,
        params.reportCategoryId ? `report_category_id = ${Number(params.reportCategoryId)}` : null
      ],
      "date ASC"
    ),
    competitive_visibility_top_merchants: () => compose(
      "domain, rank, relative_visibility, ads_organic_ratio, page_overlap_rate, higher_position_rate, is_your_domain, traffic_source, date, report_country_code, report_category_id",
      "competitive_visibility_top_merchant_view",
      [
        `date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'`,
        country ? `report_country_code = ${quoteMerchantLiteral(country)}` : null,
        params.reportCategoryId ? `report_category_id = ${Number(params.reportCategoryId)}` : null
      ],
      "rank ASC"
    ),
    competitive_visibility: () => compose(
      "domain, rank, relative_visibility, ads_organic_ratio, page_overlap_rate, higher_position_rate, is_your_domain, traffic_source, date, report_country_code, report_category_id",
      "competitive_visibility_competitor_view",
      [
        `date BETWEEN '${dateRange.startDate}' AND '${dateRange.endDate}'`,
        country ? `report_country_code = ${quoteMerchantLiteral(country)}` : null,
        params.reportCategoryId ? `report_category_id = ${Number(params.reportCategoryId)}` : null
      ],
      "relative_visibility DESC"
    )
  };

  const CATEGORY_REQUIRED = ["competitive_visibility", "competitive_visibility_benchmark", "competitive_visibility_top_merchants"];
  if (CATEGORY_REQUIRED.includes(params.preset) && !params.reportCategoryId) {
    throw new Error(
      `${params.preset} requires reportCategoryId (a numeric Google product category ID, for example 536 for Home & Garden). ` +
      "Run the product_performance preset first and use the category_l1 it reports to pick one."
    );
  }
  const COUNTRY_REQUIRED = [
    "price_competitiveness",
    "best_sellers",
    "best_sellers_brands",
    "competitive_visibility",
    "competitive_visibility_benchmark",
    "competitive_visibility_top_merchants"
  ];
  if (COUNTRY_REQUIRED.includes(params.preset) && !country) {
    throw new Error(`${params.preset} requires reportCountryCode, for example "IN" or "US".`);
  }
  const build = presets[params.preset];
  if (!build) throw new Error(`Unsupported Merchant Center preset: ${params.preset}`);
  const definition = MERCHANT_PRESET_DEFINITIONS[params.preset];
  return {
    entityType: definition.entityType,
    view: definition.view,
    table: definition.table,
    query: build(),
    dateRange,
    limit,
    timeSeries: [
      "product_performance",
      "brand_performance",
      "category_performance",
      "country_performance",
      "non_product_performance",
      "competitive_visibility",
      "competitive_visibility_benchmark",
      "competitive_visibility_top_merchants"
    ].includes(params.preset)
  };
}

function normalizeMerchantPresetRows(preset, responseBody) {
  const definition = MERCHANT_PRESET_DEFINITIONS[preset];
  const viewKey = definition ? definition.view.charAt(0).toLowerCase() + definition.view.slice(1) : null;
  const rows = responseBody?.results || [];
  return rows.map((result) => {
    const row = (viewKey && result[viewKey]) || Object.values(result)[0] || {};
    return buildNormalizedRecord({
      platform: "merchant_center",
      preset,
      entityType: definition?.entityType || "custom",
      sourcePrimaryKey: firstDefined(
        row.offerId,
        row.id,
        row.domain,
        row.brand,
        row.categoryL1,
        row.title,
        row.customerCountryCode,
        row.date
      ) || null,
      dimensions: {
        date: row.date || row.reportDate,
        product_id: row.offerId || row.id,
        product_title: row.title,
        product_brand: row.brand,
        brand: row.brand,
        product_type: row.categoryL1 || row.categoryL2,
        channel: row.marketingMethod || row.trafficSource,
        country: row.customerCountryCode || row.reportCountryCode,
        domain: row.domain,
        availability: row.availability,
        condition: row.condition,
        approval_status: row.aggregatedReportingContextStatus
      },
      metrics: {
        clicks: toNumber(row.clicks),
        impressions: toNumber(row.impressions),
        ctr: toNumber(row.clickThroughRate),
        conversions: toNumber(row.conversions),
        // Merchant Price fields carry amountMicros, so scale them to normal currency.
        conversion_value: microsToStandardCurrency(row.conversionValue?.amountMicros),
        price: microsToStandardCurrency(row.price?.amountMicros),
        benchmark_price: microsToStandardCurrency(row.benchmarkPrice?.amountMicros),
        suggested_price: microsToStandardCurrency(row.suggestedPrice?.amountMicros),
        conversion_rate: toNumber(row.conversionRate),
        rank: toNumber(row.rank),
        previous_rank: toNumber(row.previousRank),
        relative_visibility: toNumber(row.relativeVisibility),
        page_overlap_rate: toNumber(row.pageOverlapRate),
        higher_position_rate: toNumber(row.higherPositionRate),
        ads_organic_ratio: toNumber(row.adsOrganicRatio),
        click_potential_rank: toNumber(row.clickPotentialRank),
        predicted_clicks_change: toNumber(row.predictedClicksChangeFraction),
        predicted_conversions_change: toNumber(row.predictedConversionsChangeFraction)
      },
      sourceContext: row
    });
  });
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeGoogleAdsPresetRows(preset, responseBody) {
  const rows = responseBody?.results || [];
  return rows.map((row) => {
    const dimensions = {
      date: firstDefined(getGoogleAdsValue(row, "segments.date"), getGoogleAdsValue(row, "change_event.change_date_time")),
      campaign_id: getGoogleAdsValue(row, "campaign.id"),
      campaign_name: getGoogleAdsValue(row, "campaign.name"),
      ad_group_id: getGoogleAdsValue(row, "ad_group.id"),
      ad_group_name: getGoogleAdsValue(row, "ad_group.name"),
      ad_id: getGoogleAdsValue(row, "ad_group_ad.ad.id"),
      ad_type: getGoogleAdsValue(row, "ad_group_ad.ad.type"),
      keyword_text: firstDefined(getGoogleAdsValue(row, "ad_group_criterion.keyword.text"), getGoogleAdsValue(row, "campaign_criterion.keyword.text"), getGoogleAdsValue(row, "shared_criterion.keyword.text"), getGoogleAdsValue(row, "click_view.keyword_info.text")),
      keyword_match_type: firstDefined(getGoogleAdsValue(row, "ad_group_criterion.keyword.match_type"), getGoogleAdsValue(row, "campaign_criterion.keyword.match_type"), getGoogleAdsValue(row, "shared_criterion.keyword.match_type")),
      search_term: firstDefined(getGoogleAdsValue(row, "search_term_view.search_term"), getGoogleAdsValue(row, "campaign_search_term_insight.category_label")),
      channel: firstDefined(getGoogleAdsValue(row, "campaign.advertising_channel_type"), getGoogleAdsValue(row, "campaign.advertising_channel_sub_type")),
      asset_id: getGoogleAdsValue(row, "asset.id"),
      asset_name: getGoogleAdsValue(row, "asset.name"),
      asset_type: getGoogleAdsValue(row, "asset.type"),
      asset_group_id: getGoogleAdsValue(row, "asset_group.id"),
      asset_group_name: getGoogleAdsValue(row, "asset_group.name"),
      device: firstDefined(getGoogleAdsValue(row, "segments.device")),
      day_of_week: getGoogleAdsValue(row, "segments.day_of_week"),
      hour: getGoogleAdsValue(row, "segments.hour"),
      country: firstDefined(getGoogleAdsValue(row, "segments.geo_target_country"), getGoogleAdsValue(row, "geographic_view.country_criterion_id"), getGoogleAdsValue(row, "segments.product_country")),
      region: getGoogleAdsValue(row, "segments.geo_target_region"),
      city: getGoogleAdsValue(row, "segments.geo_target_city"),
      product_id: getGoogleAdsValue(row, "segments.product_item_id"),
      product_title: getGoogleAdsValue(row, "segments.product_title"),
      product_brand: getGoogleAdsValue(row, "segments.product_brand"),
      product_type: firstDefined(getGoogleAdsValue(row, "segments.product_type_l1"), getGoogleAdsValue(row, "segments.product_type_l2")),
      age_range: getGoogleAdsValue(row, "ad_group_criterion.age_range.type"),
      gender: getGoogleAdsValue(row, "ad_group_criterion.gender.type"),
      audience: getGoogleAdsValue(row, "ad_group_criterion.display_name"),
      placement: firstDefined(getGoogleAdsValue(row, "group_placement_view.display_name"), getGoogleAdsValue(row, "group_placement_view.placement")),
      conversion_action_name: getGoogleAdsValue(row, "segments.conversion_action_name"),
      conversion_action_category: getGoogleAdsValue(row, "segments.conversion_action_category"),
      landing_page: firstDefined(getGoogleAdsValue(row, "landing_page_view.unexpanded_final_url"), getGoogleAdsValue(row, "expanded_landing_page_view.expanded_final_url")),
      budget_id: getGoogleAdsValue(row, "campaign_budget.id"),
      budget_name: getGoogleAdsValue(row, "campaign_budget.name"),
      bidding_strategy_name: firstDefined(getGoogleAdsValue(row, "bidding_strategy.name"), getGoogleAdsValue(row, "campaign.bidding_strategy_type")),
      video_id: getGoogleAdsValue(row, "video.id"),
      video_title: getGoogleAdsValue(row, "video.title"),
      gclid: getGoogleAdsValue(row, "click_view.gclid"),
      currency: firstDefined(getGoogleAdsValue(row, "customer.currency_code"), getGoogleAdsValue(row, "bidding_strategy.effective_currency_code"))
    };

    const sourcePrimaryKey = firstDefined(
      dimensions.gclid,
      dimensions.keyword_text ? `${dimensions.ad_group_id || ""}:${dimensions.keyword_text}` : undefined,
      dimensions.search_term ? `${dimensions.campaign_id || ""}:${dimensions.search_term}` : undefined,
      dimensions.product_id,
      dimensions.asset_id,
      dimensions.asset_group_id,
      dimensions.video_id,
      dimensions.ad_id,
      dimensions.budget_id,
      getGoogleAdsValue(row, "bidding_strategy.id"),
      getGoogleAdsValue(row, "experiment.experiment_id"),
      getGoogleAdsValue(row, "recommendation.resource_name"),
      getGoogleAdsValue(row, "change_event.change_resource_name"),
      dimensions.ad_group_id,
      dimensions.campaign_id,
      getGoogleAdsValue(row, "customer.id")
    );

    return buildNormalizedRecord({
      platform: "google_ads",
      preset,
      entityType: GOOGLE_ADS_PRESET_DEFINITIONS[preset]?.entityType || "custom",
      sourcePrimaryKey,
      dimensions,
      metrics: {
        impressions: toNumber(getGoogleAdsValue(row, "metrics.impressions")),
        clicks: toNumber(getGoogleAdsValue(row, "metrics.clicks")),
        ctr: toNumber(getGoogleAdsValue(row, "metrics.ctr")),
        average_cpc: microsToStandardCurrency(getGoogleAdsValue(row, "metrics.average_cpc")),
        average_cpm: microsToStandardCurrency(getGoogleAdsValue(row, "metrics.average_cpm")),
        cost: microsToStandardCurrency(getGoogleAdsValue(row, "metrics.cost_micros")),
        conversions: toNumber(getGoogleAdsValue(row, "metrics.conversions")),
        conversion_value: toNumber(getGoogleAdsValue(row, "metrics.conversions_value")),
        all_conversions: toNumber(getGoogleAdsValue(row, "metrics.all_conversions")),
        all_conversions_value: toNumber(getGoogleAdsValue(row, "metrics.all_conversions_value")),
        cost_per_conversion: microsToStandardCurrency(getGoogleAdsValue(row, "metrics.cost_per_conversion")),
        value_per_conversion: toNumber(getGoogleAdsValue(row, "metrics.value_per_conversion")),
        conversion_rate: toNumber(getGoogleAdsValue(row, "metrics.conversions_from_interactions_rate")),
        interactions: toNumber(getGoogleAdsValue(row, "metrics.interactions")),
        interaction_rate: toNumber(getGoogleAdsValue(row, "metrics.interaction_rate")),
        search_impression_share: toNumber(getGoogleAdsValue(row, "metrics.search_impression_share")),
        search_budget_lost_impression_share: toNumber(getGoogleAdsValue(row, "metrics.search_budget_lost_impression_share")),
        search_rank_lost_impression_share: toNumber(getGoogleAdsValue(row, "metrics.search_rank_lost_impression_share")),
        search_top_impression_share: toNumber(getGoogleAdsValue(row, "metrics.search_top_impression_share")),
        search_absolute_top_impression_share: toNumber(getGoogleAdsValue(row, "metrics.search_absolute_top_impression_share")),
        absolute_top_impression_percentage: toNumber(getGoogleAdsValue(row, "metrics.absolute_top_impression_percentage")),
        top_impression_percentage: toNumber(getGoogleAdsValue(row, "metrics.top_impression_percentage")),
        quality_score: toNumber(getGoogleAdsValue(row, "ad_group_criterion.quality_info.quality_score")),
        video_views: toNumber(getGoogleAdsValue(row, "metrics.video_views")),
        video_view_rate: toNumber(getGoogleAdsValue(row, "metrics.video_view_rate")),
        average_cpv: microsToStandardCurrency(getGoogleAdsValue(row, "metrics.average_cpv")),
        call_duration_seconds: toNumber(getGoogleAdsValue(row, "call_view.call_duration_seconds"))
      },
      sourceContext: {
        status: firstDefined(
          getGoogleAdsValue(row, "campaign.status"),
          getGoogleAdsValue(row, "ad_group.status"),
          getGoogleAdsValue(row, "ad_group_criterion.status"),
          getGoogleAdsValue(row, "ad_group_ad.status"),
          getGoogleAdsValue(row, "asset_group.status"),
          getGoogleAdsValue(row, "experiment.status"),
          getGoogleAdsValue(row, "call_view.call_status")
        ),
        performance_label: getGoogleAdsValue(row, "ad_group_ad_asset_view.performance_label"),
        ad_strength: firstDefined(getGoogleAdsValue(row, "ad_group_ad.ad_strength"), getGoogleAdsValue(row, "asset_group.ad_strength")),
        approval_status: getGoogleAdsValue(row, "ad_group_ad.policy_summary.approval_status"),
        quality_creative: getGoogleAdsValue(row, "ad_group_criterion.quality_info.creative_quality_score"),
        quality_landing_page: getGoogleAdsValue(row, "ad_group_criterion.quality_info.post_click_quality_score"),
        quality_expected_ctr: getGoogleAdsValue(row, "ad_group_criterion.quality_info.search_predicted_ctr"),
        recommendation_type: getGoogleAdsValue(row, "recommendation.type"),
        change_user: getGoogleAdsValue(row, "change_event.user_email"),
        changed_fields: getGoogleAdsValue(row, "change_event.changed_fields"),
        change_operation: getGoogleAdsValue(row, "change_event.resource_change_operation"),
        optimization_score: toNumber(getGoogleAdsValue(row, "customer.optimization_score"))
      }
    });
  });
}

function normalizeGa4PresetRows(preset, responseBody) {
  const rows = mapGa4ReportRows(responseBody);
  return rows.map((row) => {
    const d = row.dimensions;
    const m = row.metrics;
    const dimensions = {
      date: d.date,
      campaign_name: firstDefined(d.sessionCampaignName, d.sessionGoogleAdsCampaignName, d.firstUserCampaignName),
      source_medium: firstDefined(d.sessionSourceMedium, d.firstUserSourceMedium),
      source: firstDefined(d.sessionSource, d.firstUserSource),
      medium: firstDefined(d.sessionMedium, d.firstUserMedium),
      channel: firstDefined(d.sessionDefaultChannelGroup, d.firstUserDefaultChannelGroup),
      landing_page: d.landingPagePlusQueryString,
      page: firstDefined(d.pagePath, d.pageTitle),
      event_name: d.eventName,
      query: d.searchTerm,
      product_id: d.itemId,
      product_title: firstDefined(d.itemName, d.itemListName, d.itemPromotionName),
      product_brand: d.itemBrand,
      product_type: d.itemCategory,
      country: d.country,
      region: d.region,
      city: d.city,
      language: d.language,
      device: d.deviceCategory,
      operating_system: d.operatingSystem,
      browser: d.browser,
      age_range: d.userAgeBracket,
      gender: d.userGender,
      audience: firstDefined(d.audienceName, d.newVsReturning)
    };
    return buildNormalizedRecord({
      platform: "ga4",
      preset,
      entityType: GA4_PRESET_DEFINITIONS[preset]?.entityType || "custom",
      sourcePrimaryKey: firstDefined(
        dimensions.campaign_name,
        dimensions.landing_page,
        dimensions.page,
        dimensions.source_medium,
        dimensions.product_title,
        dimensions.event_name,
        dimensions.query,
        dimensions.country,
        dimensions.device,
        dimensions.audience,
        dimensions.channel,
        dimensions.date
      ) || null,
      dimensions,
      metrics: {
        sessions: toNumber(m.sessions),
        users: toNumber(firstDefined(m.totalUsers, m.activeUsers)),
        new_users: toNumber(m.newUsers),
        engaged_sessions: toNumber(m.engagedSessions),
        engagement_rate: toNumber(m.engagementRate),
        bounce_rate: toNumber(m.bounceRate),
        average_session_duration: toNumber(m.averageSessionDuration),
        page_views: toNumber(m.screenPageViews),
        event_count: toNumber(m.eventCount),
        event_value: toNumber(m.eventValue),
        // GA4 exposes the outcome metric under either name depending on property migration.
        conversions: toNumber(firstDefined(m.keyEvents, m.conversions)),
        revenue: toNumber(firstDefined(m.totalRevenue, m.purchaseRevenue, m.itemRevenue)),
        transactions: toNumber(m.ecommercePurchases),
        items_viewed: toNumber(m.itemsViewed),
        items_added_to_cart: toNumber(firstDefined(m.itemsAddedToCart, m.addToCarts)),
        items_purchased: toNumber(m.itemsPurchased),
        cost: toNumber(m.advertiserAdCost),
        clicks: toNumber(m.advertiserAdClicks),
        impressions: toNumber(m.advertiserAdImpressions),
        return_on_ad_spend: toNumber(m.returnOnAdSpend)
      },
      sourceContext: { dimensions: d, metrics: m }
    });
  });
}

function normalizeSearchConsolePresetRows(preset, responseBody, dimensions = [], postFilter = null) {
  const allRows = buildSearchConsoleRowObjects(responseBody, dimensions);
  const rows = applySearchConsolePostFilter(allRows, postFilter);
  return rows.map((row) => buildNormalizedRecord({
    platform: "search_console",
    preset,
    entityType: SEARCH_CONSOLE_PRESET_DEFINITIONS[preset]?.entityType || "custom",
    sourcePrimaryKey: firstDefined(
      row.query && row.page ? `${row.query} :: ${row.page}` : undefined,
      row.query,
      row.page,
      row.searchAppearance,
      row.country,
      row.device,
      row.date
    ) || null,
    dimensions: {
      date: row.date,
      query: row.query,
      page: row.page,
      country: row.country,
      device: row.device,
      search_appearance: row.searchAppearance,
      channel: responseBody?.responseAggregationType
    },
    metrics: {
      clicks: toNumber(row.clicks),
      impressions: toNumber(row.impressions),
      ctr: toNumber(row.ctr),
      average_position: toNumber(row.position)
    },
    sourceContext: {
      keys: row.keys
    }
  }));
}

function callRailDurationBucket(seconds) {
  const value = toNumber(seconds) || 0;
  if (value < 30) return "0-30s";
  if (value < 60) return "30-60s";
  if (value < 120) return "1-2m";
  if (value < 300) return "2-5m";
  if (value < 600) return "5-10m";
  return "10m+";
}

function callRailGroupKeys(call, groupBy) {
  if (!groupBy) return [null];
  if (groupBy === "duration_bucket") return [callRailDurationBucket(call.duration)];
  if (groupBy === "call_date") return [String(call.start_time || "").slice(0, 10) || "(unknown)"];
  if (groupBy === "answered") return [call.answered ? "answered" : "missed"];
  if (groupBy === "first_call") return [call.first_call ? "first_time" : "repeat"];
  if (groupBy === "tags") {
    const tags = Array.isArray(call.tags) ? call.tags : [];
    if (!tags.length) return ["(untagged)"];
    // A call with several tags contributes one row per tag, so tag totals exceed call totals.
    return tags.map((tag) => (typeof tag === "string" ? tag : tag?.name || "(untagged)"));
  }
  const raw = call[groupBy];
  if (raw === undefined || raw === null || raw === "") return ["(not set)"];
  return [String(raw)];
}

function aggregateCallRailCalls(calls, preset) {
  const definition = CALLRAIL_PRESET_DEFINITIONS[preset];
  const groupBy = definition?.groupBy || null;
  const buckets = new Map();
  for (const call of calls) {
    for (const key of callRailGroupKeys(call, definition?.aggregateAll ? null : groupBy)) {
      const bucketKey = key === null ? "__all__" : key;
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, {
          key: key === null ? "all_calls" : key,
          calls: 0,
          answered_calls: 0,
          missed_calls: 0,
          voicemails: 0,
          first_time_callers: 0,
          qualified_calls: 0,
          total_duration_seconds: 0,
          lead_value: 0
        });
      }
      const bucket = buckets.get(bucketKey);
      bucket.calls += 1;
      if (call.answered) bucket.answered_calls += 1;
      else bucket.missed_calls += 1;
      if (call.voicemail) bucket.voicemails += 1;
      if (call.first_call) bucket.first_time_callers += 1;
      if (String(call.lead_status || "").toLowerCase() === "good_lead") bucket.qualified_calls += 1;
      bucket.total_duration_seconds += toNumber(call.duration) || 0;
      bucket.lead_value += toNumber(call.value) || 0;
    }
  }
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      average_duration_seconds: bucket.calls ? Math.round(bucket.total_duration_seconds / bucket.calls) : 0,
      answer_rate: bucket.calls ? bucket.answered_calls / bucket.calls : 0
    }))
    .sort((a, b) => b.calls - a.calls);
}

function normalizeCallRailPresetRows(preset, aggregatedRows) {
  const definition = CALLRAIL_PRESET_DEFINITIONS[preset];
  const groupBy = definition?.groupBy;
  const dimensionKeyFor = {
    source: "source_medium",
    medium: "source_medium",
    referrer: "source_medium",
    campaign: "campaign_name",
    keywords: "query",
    landing_page_url: "landing_page",
    tracking_phone_number: "tracker_id",
    company_name: "account_name",
    device_type: "device",
    customer_city: "city",
    lead_status: "call_segment",
    tags: "call_segment",
    answered: "call_segment",
    first_call: "call_segment",
    duration_bucket: "call_segment",
    call_date: "date"
  }[groupBy] || "call_segment";
  return aggregatedRows.map((row) => buildNormalizedRecord({
    platform: "callrail",
    preset,
    entityType: definition?.entityType || "call",
    sourcePrimaryKey: row.key,
    dimensions: { [dimensionKeyFor]: row.key },
    metrics: {
      calls: row.calls,
      answered_calls: row.answered_calls,
      missed_calls: row.missed_calls,
      qualified_calls: row.qualified_calls,
      first_time_callers: row.first_time_callers,
      call_duration_seconds: row.total_duration_seconds,
      average_call_duration_seconds: row.average_duration_seconds,
      answer_rate: row.answer_rate,
      revenue: row.lead_value
    },
    sourceContext: { groupBy: groupBy || "none", voicemails: row.voicemails }
  }));
}

function normalizeCallRailCallRecords(calls) {
  return calls.map((call) => buildNormalizedRecord({
    platform: "callrail",
    preset: "call_details",
    entityType: "call",
    sourcePrimaryKey: call.id ? String(call.id) : null,
    dimensions: {
      date: String(call.start_time || "").slice(0, 10) || undefined,
      call_id: call.id ? String(call.id) : undefined,
      campaign_name: firstDefined(call.utm_campaign, call.campaign),
      source_medium: firstDefined(
        call.utm_source && call.utm_medium ? `${call.utm_source} / ${call.utm_medium}` : undefined,
        call.source && call.medium ? `${call.source} / ${call.medium}` : undefined,
        call.source_name,
        call.source
      ),
      source: firstDefined(call.utm_source, call.source),
      medium: firstDefined(call.utm_medium, call.medium),
      query: firstDefined(call.utm_term, call.keywords),
      landing_page: call.landing_page_url,
      tracker_id: call.tracking_phone_number,
      device: call.device_type,
      city: call.customer_city,
      country: call.customer_country
    },
    metrics: {
      calls: 1,
      answered_calls: call.answered ? 1 : 0,
      missed_calls: call.answered ? 0 : 1,
      qualified_calls: String(call.lead_status || "").toLowerCase() === "good_lead" ? 1 : 0,
      first_time_callers: call.first_call ? 1 : 0,
      call_duration_seconds: toNumber(call.duration),
      revenue: toNumber(call.value)
    },
    sourceContext: {
      lead_status: call.lead_status,
      tags: call.tags,
      gclid: call.gclid,
      referrer: call.referrer,
      voicemail: call.voicemail,
      prior_calls: call.prior_calls
    }
  }));
}

function metaAdsLevelFields(level) {
  if (level === "campaign") return "campaign_id,campaign_name";
  if (level === "adset") return "campaign_id,campaign_name,adset_id,adset_name";
  if (level === "ad") return "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name";
  return "account_id,account_name";
}

function buildMetaPresetRequest(params) {
  const definition = META_PRESET_DEFINITIONS[params.preset];
  if (!definition) throw new Error(`Unsupported Meta preset: ${params.preset}`);

  const dateRange = resolveDateWindow(params);
  const notes = [];
  const limit = Math.min(Number(params.limit || 100), 500);

  if (definition.surface === "ads") {
    if (!params.adAccountId) throw new Error(`Meta preset "${params.preset}" requires adAccountId, for example act_1234567890 or 1234567890.`);
    const raw = String(params.adAccountId).trim();
    const accountPath = raw.startsWith("act_") ? raw : `act_${raw.replace(/[^0-9]/g, "")}`;
    const fields = definition.fields === "video"
      ? `${metaAdsLevelFields(definition.level)},${META_ADS_VIDEO_FIELDS}`
      : `${metaAdsLevelFields(definition.level)},${META_ADS_BASE_FIELDS}`;
    return {
      surface: "ads",
      shape: "insights",
      entityType: definition.entityType,
      needsPageToken: false,
      path: `${accountPath}/insights`,
      query: {
        level: definition.level,
        fields: params.fields || fields,
        time_range: JSON.stringify({ since: dateRange.startDate, until: dateRange.endDate }),
        time_increment: params.includeDailyBreakdown === true ? 1 : definition.timeIncrement,
        breakdowns: params.breakdowns || definition.breakdowns,
        action_breakdowns: params.actionBreakdowns,
        filtering: params.filtering ? JSON.stringify(params.filtering) : undefined,
        limit,
        after: params.after
      },
      dateRange,
      notes
    };
  }

  if (definition.surface === "page") {
    if (!params.pageId) throw new Error(`Meta preset "${params.preset}" requires pageId.`);
    if (definition.shape === "edge") {
      return {
        surface: "page",
        shape: "edge",
        entityType: definition.entityType,
        needsPageToken: true,
        path: `${params.pageId}/${definition.edge}`,
        query: {
          fields: params.fields || "id,message,created_time,permalink_url,insights.metric(post_impressions,post_impressions_unique,post_engaged_users,post_clicks)",
          since: dateRange.startDate,
          until: dateRange.endDate,
          limit,
          after: params.after
        },
        dateRange,
        notes
      };
    }
    return {
      surface: "page",
      shape: "metric_series",
      entityType: definition.entityType,
      needsPageToken: true,
      path: `${params.pageId}/insights`,
      query: {
        metric: params.metrics || definition.metrics,
        period: params.period || definition.period || "day",
        since: dateRange.startDate,
        until: dateRange.endDate
      },
      dateRange,
      notes
    };
  }

  // Instagram
  if (!params.instagramAccountId) {
    throw new Error(`Meta preset "${params.preset}" requires instagramAccountId. Find it with list_meta_instagram_accounts.`);
  }
  if (!params.pageId) {
    notes.push("No pageId supplied, so the user access token is used. Instagram insights are documented against the linked Page access token; pass pageId if Meta rejects the call.");
  }
  if (definition.shape === "edge") {
    const fields = definition.edge === "stories"
      ? "id,media_type,media_product_type,timestamp,permalink,insights.metric(reach,replies)"
      : "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,insights.metric(reach,saved,shares,total_interactions)";
    if (definition.edge === "stories") {
      notes.push("Instagram only exposes stories from the last 24 hours, so the date range does not apply.");
    }
    return {
      surface: "instagram",
      shape: "edge",
      entityType: definition.entityType,
      needsPageToken: Boolean(params.pageId),
      path: `${params.instagramAccountId}/${definition.edge}`,
      query: {
        fields: params.fields || fields,
        since: definition.edge === "stories" ? undefined : dateRange.startDate,
        until: definition.edge === "stories" ? undefined : dateRange.endDate,
        limit,
        after: params.after
      },
      dateRange,
      notes
    };
  }
  if (definition.shape === "demographics") {
    return {
      surface: "instagram",
      shape: "demographics",
      entityType: definition.entityType,
      needsPageToken: Boolean(params.pageId),
      path: `${params.instagramAccountId}/insights`,
      query: {
        metric: params.metrics || definition.metrics,
        period: "lifetime",
        metric_type: "total_value",
        breakdown: params.breakdowns || "country"
      },
      dateRange,
      notes
    };
  }
  return {
    surface: "instagram",
    shape: "metric_series",
    entityType: definition.entityType,
    needsPageToken: Boolean(params.pageId),
    path: `${params.instagramAccountId}/insights`,
    query: {
      metric: params.metrics || definition.metrics,
      period: params.period || definition.period || "day",
      since: dateRange.startDate,
      until: dateRange.endDate
    },
    dateRange,
    notes
  };
}

function sumMetaActions(actions, types) {
  if (!Array.isArray(actions)) return undefined;
  let total;
  for (const entry of actions) {
    if (types && !types.includes(entry?.action_type)) continue;
    const value = toNumber(entry?.value);
    if (value === undefined) continue;
    total = (total || 0) + value;
  }
  return total;
}

function firstMetaActionValue(actions) {
  if (!Array.isArray(actions) || !actions.length) return undefined;
  return toNumber(actions[0]?.value);
}

function normalizeMetaAdsRows(preset, responseBody, conversionActionType) {
  const definition = META_PRESET_DEFINITIONS[preset];
  const types = conversionActionType ? [conversionActionType] : META_CONVERSION_ACTION_TYPES;
  return (responseBody?.data || []).map((row) => {
    const dimensions = {
      date: row.date_start,
      ad_account_id: row.account_id,
      account_name: row.account_name,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      ad_set_id: row.adset_id,
      ad_set_name: row.adset_name,
      ad_id: row.ad_id,
      ad_name: row.ad_name,
      age_range: row.age,
      gender: row.gender,
      country: row.country,
      region: row.region,
      device: firstDefined(row.impression_device, row.device_platform),
      publisher_platform: row.publisher_platform,
      placement: firstDefined(row.platform_position, row.publisher_platform),
      currency: row.account_currency
    };
    return buildNormalizedRecord({
      platform: "meta",
      preset,
      entityType: definition?.entityType || "custom",
      sourcePrimaryKey: firstDefined(
        dimensions.ad_id,
        dimensions.ad_set_id,
        dimensions.campaign_id,
        dimensions.age_range && dimensions.gender ? `${dimensions.age_range}:${dimensions.gender}` : undefined,
        dimensions.country,
        dimensions.placement,
        dimensions.device,
        dimensions.ad_account_id,
        dimensions.date
      ) || null,
      dimensions,
      metrics: {
        impressions: toNumber(row.impressions),
        clicks: toNumber(row.clicks),
        cost: toNumber(row.spend),
        ctr: toNumber(row.ctr),
        average_cpc: toNumber(row.cpc),
        average_cpm: toNumber(row.cpm),
        reach: toNumber(row.reach),
        frequency: toNumber(row.frequency),
        conversions: sumMetaActions(row.actions, types),
        conversion_value: sumMetaActions(row.action_values, types),
        return_on_ad_spend: firstMetaActionValue(row.purchase_roas),
        video_plays: sumMetaActions(row.video_play_actions),
        video_views: sumMetaActions(row.video_thruplay_watched_actions),
        video_completions: sumMetaActions(row.video_p100_watched_actions)
      },
      sourceContext: {
        actions: row.actions,
        action_values: row.action_values,
        cost_per_action_type: row.cost_per_action_type,
        date_stop: row.date_stop,
        conversion_action_types_used: types
      }
    });
  });
}

const META_METRIC_ALIASES = {
  page_impressions: "impressions",
  page_impressions_unique: "reach",
  page_post_engagements: "engagements",
  page_views_total: "page_views",
  page_fans: "followers",
  page_fan_adds: "follower_adds",
  page_fan_removes: "follower_removes",
  post_impressions: "impressions",
  post_impressions_unique: "reach",
  post_engaged_users: "engagements",
  post_clicks: "clicks",
  reach: "reach",
  impressions: "impressions",
  views: "impressions",
  profile_views: "profile_views",
  follower_count: "follower_adds",
  saved: "saves",
  shares: "shares",
  replies: "comments",
  total_interactions: "engagements"
};

// Page and Instagram insights come back metric-major, so pivot them into one row
// per end_time with every metric attached.
function normalizeMetaMetricSeriesRows(preset, responseBody) {
  const definition = META_PRESET_DEFINITIONS[preset];
  const byDate = new Map();
  for (const metric of responseBody?.data || []) {
    const normalizedName = META_METRIC_ALIASES[metric?.name] || metric?.name;
    for (const point of metric?.values || []) {
      const date = String(point?.end_time || "").slice(0, 10) || "(unknown)";
      if (!byDate.has(date)) byDate.set(date, {});
      const value = toNumber(point?.value);
      if (value !== undefined) byDate.get(date)[normalizedName] = value;
    }
  }
  return [...byDate.entries()].map(([date, metrics]) => buildNormalizedRecord({
    platform: "meta",
    preset,
    entityType: definition?.entityType || "custom",
    sourcePrimaryKey: date,
    dimensions: { date },
    metrics,
    sourceContext: { shape: "metric_series" }
  }));
}

function flattenMetaEdgeInsights(node) {
  const metrics = {};
  for (const metric of node?.insights?.data || []) {
    const normalizedName = META_METRIC_ALIASES[metric?.name] || metric?.name;
    const value = toNumber(metric?.values?.[0]?.value);
    if (value !== undefined) metrics[normalizedName] = value;
  }
  return metrics;
}

function normalizeMetaEdgeRows(preset, responseBody) {
  const definition = META_PRESET_DEFINITIONS[preset];
  return (responseBody?.data || []).map((node) => {
    const isPost = definition?.surface === "page";
    return buildNormalizedRecord({
      platform: "meta",
      preset,
      entityType: definition?.entityType || "custom",
      sourcePrimaryKey: node.id || null,
      dimensions: {
        date: String(node.created_time || node.timestamp || "").slice(0, 10) || undefined,
        post_id: isPost ? node.id : undefined,
        media_id: isPost ? undefined : node.id,
        media_type: firstDefined(node.media_product_type, node.media_type),
        page: node.permalink_url || node.permalink,
        product_title: node.caption || node.message
      },
      metrics: {
        ...flattenMetaEdgeInsights(node),
        likes: toNumber(node.like_count),
        comments: toNumber(node.comments_count)
      },
      sourceContext: { shape: "edge", raw: node }
    });
  });
}

function normalizeMetaDemographicsRows(preset, responseBody) {
  const definition = META_PRESET_DEFINITIONS[preset];
  const rows = [];
  for (const metric of responseBody?.data || []) {
    for (const breakdown of metric?.total_value?.breakdowns || []) {
      const dimensionName = breakdown?.dimension_keys?.[0] || "segment";
      for (const result of breakdown?.results || []) {
        const key = result?.dimension_values?.[0];
        rows.push(buildNormalizedRecord({
          platform: "meta",
          preset,
          entityType: definition?.entityType || "demographic",
          sourcePrimaryKey: key || null,
          dimensions: {
            country: dimensionName === "country" ? key : undefined,
            city: dimensionName === "city" ? key : undefined,
            age_range: dimensionName === "age" ? key : undefined,
            gender: dimensionName === "gender" ? key : undefined
          },
          metrics: { followers: toNumber(result?.value) },
          sourceContext: { dimension: dimensionName, metric: metric?.name }
        }));
      }
    }
  }
  return rows;
}

function normalizeMetaPresetRows(preset, responseBody, options = {}) {
  const definition = META_PRESET_DEFINITIONS[preset];
  if (!definition) return [];
  if (definition.shape === "insights") return normalizeMetaAdsRows(preset, responseBody, options.conversionActionType);
  if (definition.shape === "metric_series") return normalizeMetaMetricSeriesRows(preset, responseBody);
  if (definition.shape === "demographics") return normalizeMetaDemographicsRows(preset, responseBody);
  return normalizeMetaEdgeRows(preset, responseBody);
}

// Page and Instagram insights are documented against a Page access token, which is
// fetched per call. Costs one extra Graph request; ads presets never need it.
async function resolveMetaPageAccessToken(userAccessToken, pageId) {
  const response = await callMetaGraphApi(String(pageId), userAccessToken, { fields: "access_token" });
  if (!response.ok || !response.body?.access_token) return null;
  return response.body.access_token;
}

function buildMarketingGuardrailsPayload() {
  return {
    expertVersion: EXPERT_VERSION,
    platforms: PLATFORM_GUARDRAILS,
    normalizedSchema: NORMALIZED_MARKETING_SCHEMA
  };
}

function buildMarketingPresetCatalog() {
  return {
    expertVersion: EXPERT_VERSION,
    google_ads: GOOGLE_ADS_PRESET_DEFINITIONS,
    ga4: GA4_PRESET_DEFINITIONS,
    search_console: SEARCH_CONSOLE_PRESET_DEFINITIONS,
    merchant_center: MERCHANT_PRESET_DEFINITIONS,
    callrail: CALLRAIL_PRESET_DEFINITIONS,
    meta: META_PRESET_DEFINITIONS
  };
}

function getEnvironmentPresence() {
  return {
    GOOGLE_CLIENT_ID: Boolean(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    APP_BASE_URL: Boolean(process.env.APP_BASE_URL || process.env.BASE_URL),
    APP_ENCRYPTION_KEY: Boolean(process.env.APP_ENCRYPTION_KEY || process.env.SESSION_SECRET),
    GOOGLE_ADS_DEVELOPER_TOKEN: Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: Boolean(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
    GOOGLE_ADS_ACCESS_LEVEL: String(process.env.GOOGLE_ADS_ACCESS_LEVEL || "basic"),
    META_APP_ID: Boolean(process.env.META_APP_ID),
    META_APP_SECRET: Boolean(process.env.META_APP_SECRET),
    META_GRAPH_API_VERSION: String(process.env.META_GRAPH_API_VERSION || "v21.0"),
    META_LOGIN_CONFIG_ID: Boolean(process.env.META_LOGIN_CONFIG_ID),
    CALLRAIL_API_TOKEN: Boolean(process.env.CALLRAIL_API_TOKEN),
    CALLRAIL_ALLOW_SHARED_TOKEN: allowsSharedCallRailToken(),
    ACCESS_ALLOWLIST: describeAllowlist(),
    CALLRAIL_OFFER_STEP: shouldOfferCallRail(),
    CALLRAIL_API_BASE_URL: Boolean(process.env.CALLRAIL_API_BASE_URL)
  };
}

async function buildIntegrationDebugPayload(req) {
  const env = getEnvironmentPresence();
  const auth = {
    hasAuthorizationHeader: Boolean(req.headers.authorization),
    verified: false
  };
  try {
    const verified = await verifyMcpAccessToken(req, []);
    auth.verified = true;
    auth.scopes = verified.scopes;
    auth.scope = verified.scope;
    auth.sessionId = verified.sessionId;
    auth.resource = verified.resource;
    auth.sessionExpiresAt = verified.googleCredentials?.sessionExpiresAt || null;
    auth.googleExpiryDate = verified.googleCredentials?.expiryDate || null;
  } catch (error) {
    auth.error = formatAuthErrorResponse(error);
    if (error?.details?.required_scopes) {
      auth.requiredScopes = error.details.required_scopes;
    }
  }

  return {
    expertVersion: EXPERT_VERSION,
    baseUrl: getBaseUrl(req),
    resource: getResourceUrl(req),
    env,
    googleScopesSupported: GOOGLE_SCOPES,
    toolCoverage: {
      googleScopedTools: Object.keys(TOOL_SCOPE_MAP),
      callrailTools: CALLRAIL_TOOL_NAMES,
      advisoryTools: EXPERT_TOOL_NAMES
    },
    presets: buildMarketingPresetCatalog(),
    guardrails: PLATFORM_GUARDRAILS,
    auth
  };
}

async function listSearchConsoleSites(accessToken) {
  return callGoogleApi("https://www.googleapis.com/webmasters/v3/sites", accessToken, { method: "GET" });
}

async function querySearchConsole(accessToken, params) {
  return callGoogleApi(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(params.siteUrl)}/searchAnalytics/query`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      startDate: params.startDate,
      endDate: params.endDate,
      dimensions: params.dimensions,
      rowLimit: params.rowLimit,
      startRow: params.startRow,
      aggregationType: params.aggregationType,
      dataState: params.dataState,
      dimensionFilterGroups: params.dimensionFilterGroups,
      searchType: params.searchType,
      type: params.type
    })
  });
}

async function listGa4Properties(accessToken) {
  const accountSummaries = [];
  let pageToken;
  let lastError;
  do {
    const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await callGoogleApi(url.toString(), accessToken, { method: "GET" });
    if (!response.ok) {
      lastError = response;
      break;
    }
    accountSummaries.push(...(response.body?.accountSummaries || []));
    pageToken = response.body?.nextPageToken || undefined;
  } while (pageToken);
  if (lastError) return lastError;
  return { ok: true, status: 200, body: { accountSummaries } };
}

async function runGa4Report(accessToken, params) {
  return callGoogleApi(`https://analyticsdata.googleapis.com/v1beta/${normalizePropertyName(params.propertyId)}:runReport`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      dateRanges: params.dateRanges,
      dimensions: params.dimensions,
      metrics: params.metrics,
      dimensionFilter: params.dimensionFilter,
      metricFilter: params.metricFilter,
      offset: params.offset,
      limit: params.limit,
      metricAggregations: params.metricAggregations,
      orderBys: params.orderBys,
      currencyCode: params.currencyCode,
      cohortSpec: params.cohortSpec,
      keepEmptyRows: params.keepEmptyRows,
      returnPropertyQuota: params.returnPropertyQuota
    })
  });
}

async function runGa4FunnelReport(accessToken, params) {
  // runFunnelReport only exists on the v1alpha surface of the Data API.
  return callGoogleApi(`https://analyticsdata.googleapis.com/v1alpha/${normalizePropertyName(params.propertyId)}:runFunnelReport`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      dateRanges: params.dateRanges,
      funnelBreakdown: params.funnelBreakdown,
      funnelNextAction: params.funnelNextAction,
      funnelVisualizationType: params.funnelVisualizationType,
      segments: params.segments,
      limit: params.limit,
      dimensionFilter: params.dimensionFilter,
      funnel: params.funnel
    })
  });
}

async function listGa4AdminResource(accessToken, propertyId, resource, params = {}) {
  const url = new URL(`https://analyticsadmin.googleapis.com/v1beta/${normalizePropertyName(propertyId)}/${resource}`);
  appendQueryParams(url, { pageSize: params.pageSize, pageToken: params.pageToken });
  return callGoogleApi(url.toString(), accessToken, { method: "GET" });
}

async function getGa4Metadata(accessToken, propertyId) {
  return callGoogleApi(`https://analyticsdata.googleapis.com/v1beta/${normalizePropertyName(propertyId)}/metadata`, accessToken, {
    method: "GET"
  });
}

async function checkGa4Compatibility(accessToken, params) {
  return callGoogleApi(`https://analyticsdata.googleapis.com/v1beta/${normalizePropertyName(params.propertyId)}:checkCompatibility`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      dimensions: params.dimensions,
      metrics: params.metrics,
      dimensionFilter: params.dimensionFilter,
      metricFilter: params.metricFilter,
      compatibilityFilter: params.compatibilityFilter
    })
  });
}

async function batchRunGa4Reports(accessToken, params) {
  return callGoogleApi(`https://analyticsdata.googleapis.com/v1beta/${normalizePropertyName(params.propertyId)}:batchRunReports`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      requests: params.requests
    })
  });
}

async function runGa4RealtimeReport(accessToken, params) {
  return callGoogleApi(`https://analyticsdata.googleapis.com/v1beta/${normalizePropertyName(params.propertyId)}:runRealtimeReport`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      dimensions: params.dimensions,
      metrics: params.metrics,
      dimensionFilter: params.dimensionFilter,
      metricFilter: params.metricFilter,
      limit: params.limit,
      minuteRanges: params.minuteRanges,
      orderBys: params.orderBys,
      returnPropertyQuota: params.returnPropertyQuota
    })
  });
}

async function runGa4PivotReport(accessToken, params) {
  return callGoogleApi(`https://analyticsdata.googleapis.com/v1beta/${normalizePropertyName(params.propertyId)}:runPivotReport`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      dateRanges: params.dateRanges,
      pivots: params.pivots,
      dimensions: params.dimensions,
      metrics: params.metrics,
      dimensionFilter: params.dimensionFilter,
      metricFilter: params.metricFilter,
      currencyCode: params.currencyCode,
      cohortSpec: params.cohortSpec,
      keepEmptyRows: params.keepEmptyRows,
      returnPropertyQuota: params.returnPropertyQuota
    })
  });
}

async function listSearchConsoleSitemaps(accessToken, siteUrl) {
  return callGoogleApi(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`, accessToken, {
    method: "GET"
  });
}

async function getSearchConsoleSitemap(accessToken, siteUrl, feedpath) {
  return callGoogleApi(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, accessToken, {
    method: "GET"
  });
}

async function inspectSearchConsoleUrl(accessToken, params) {
  return callGoogleApi("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", accessToken, {
    method: "POST",
    body: JSON.stringify({
      inspectionUrl: params.inspectionUrl,
      siteUrl: params.siteUrl,
      languageCode: params.languageCode
    })
  });
}

async function listMerchantAccounts(accessToken, params = {}) {
  const url = new URL("https://merchantapi.googleapis.com/accounts/v1/accounts");
  appendQueryParams(url, {
    pageSize: params.pageSize,
    pageToken: params.pageToken,
    filter: params.filter
  });
  return callGoogleApi(url.toString(), accessToken, { method: "GET" });
}

async function getMerchantAccount(accessToken, name) {
  return callGoogleApi(`https://merchantapi.googleapis.com/accounts/v1/${normalizeMerchantAccountName(name)}`, accessToken, {
    method: "GET"
  });
}

async function listMerchantProducts(accessToken, params) {
  const parent = normalizeMerchantAccountName(params.accountId);
  const url = new URL(`https://merchantapi.googleapis.com/products/v1/${parent}/products`);
  appendQueryParams(url, {
    pageSize: params.pageSize,
    pageToken: params.pageToken
  });
  return callGoogleApi(url.toString(), accessToken, { method: "GET" });
}

async function getMerchantProduct(accessToken, name) {
  return callGoogleApi(`https://merchantapi.googleapis.com/products/v1/${String(name || "").trim()}`, accessToken, {
    method: "GET"
  });
}

async function searchMerchantReports(accessToken, params) {
  const parent = normalizeMerchantAccountName(params.accountId);
  return callGoogleApi(`https://merchantapi.googleapis.com/reports/v1/${parent}/reports:search`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      query: params.query,
      pageSize: params.pageSize,
      pageToken: params.pageToken
    })
  });
}

async function getMerchantDeveloperRegistration(accessToken, params) {
  const parent = normalizeMerchantAccountName(params.accountId);
  return callGoogleApi(`https://merchantapi.googleapis.com/accounts/v1/${parent}/developerRegistration`, accessToken, {
    method: "GET"
  });
}

// The only write call in this server. Merchant API refuses every other request with
// GCP_NOT_REGISTERED until the calling Cloud project is registered against the account.
async function registerMerchantDeveloper(accessToken, params) {
  const parent = normalizeMerchantAccountName(params.accountId);
  return callGoogleApi(`https://merchantapi.googleapis.com/accounts/v1/${parent}/developerRegistration:registerGcp`, accessToken, {
    method: "POST",
    body: JSON.stringify({ developerEmail: params.developerEmail })
  });
}

async function listMerchantSubaccounts(accessToken, params) {
  const parent = normalizeMerchantAccountName(params.accountId);
  const url = new URL(`https://merchantapi.googleapis.com/accounts/v1/${parent}:listSubaccounts`);
  appendQueryParams(url, { pageSize: params.pageSize, pageToken: params.pageToken });
  return callGoogleApi(url.toString(), accessToken, { method: "GET" });
}

async function getMerchantAccountIssues(accessToken, params) {
  const parent = normalizeMerchantAccountName(params.accountId);
  const url = new URL(`https://merchantapi.googleapis.com/accounts/v1/${parent}/issues`);
  appendQueryParams(url, {
    pageSize: params.pageSize,
    pageToken: params.pageToken,
    languageCode: params.languageCode,
    timeZone: params.timeZone
  });
  return callGoogleApi(url.toString(), accessToken, { method: "GET" });
}

async function getMerchantProductStatusSummary(accessToken, params) {
  const parent = normalizeMerchantAccountName(params.accountId);
  const url = new URL(`https://merchantapi.googleapis.com/issueresolution/v1/${parent}/aggregateProductStatuses`);
  appendQueryParams(url, {
    pageSize: params.pageSize,
    pageToken: params.pageToken,
    filter: params.filter
  });
  return callGoogleApi(url.toString(), accessToken, { method: "GET" });
}

async function listMerchantDataSources(accessToken, params) {
  const parent = normalizeMerchantAccountName(params.accountId);
  const url = new URL(`https://merchantapi.googleapis.com/datasources/v1/${parent}/dataSources`);
  appendQueryParams(url, { pageSize: params.pageSize, pageToken: params.pageToken });
  return callGoogleApi(url.toString(), accessToken, { method: "GET" });
}

async function listGoogleAdsAccessibleCustomers(accessToken) {
  return callGoogleAdsApi("customers:listAccessibleCustomers", accessToken, {
    method: "GET"
  });
}

async function queryGoogleAds(accessToken, params) {
  const customerId = normalizeGoogleAdsCustomerId(params.customerId);
  return callGoogleAdsApi(`customers/${customerId}/googleAds:search`, accessToken, {
    method: "POST",
    loginCustomerId: params.loginCustomerId,
    body: {
      query: params.query,
      pageSize: params.pageSize,
      pageToken: params.pageToken
    }
  });
}

async function searchStreamGoogleAds(accessToken, params) {
  const customerId = normalizeGoogleAdsCustomerId(params.customerId);
  return callGoogleAdsApi(`customers/${customerId}/googleAds:searchStream`, accessToken, {
    method: "POST",
    loginCustomerId: params.loginCustomerId,
    body: {
      query: params.query,
      summaryRowSetting: params.summaryRowSetting
    }
  });
}

async function getGoogleAdsField(accessToken, name) {
  return callGoogleAdsApi(`googleAdsFields/${encodeURIComponent(String(name || "").trim())}`, accessToken, {
    method: "GET"
  });
}

async function searchGoogleAdsFields(accessToken, params) {
  const url = new URL(`https://googleads.googleapis.com/${getGoogleAdsApiVersion()}/googleAdsFields:search`);
  appendQueryParams(url, {
    query: params.query,
    pageSize: params.pageSize,
    pageToken: params.pageToken
  });
  return callGoogleAdsApi(url.toString(), accessToken, {
    method: "GET"
  });
}

async function listCallRailAccounts(params = {}) {
  return callCallRailApi("/a.json", params.query, params.apiKey);
}

async function listCallRailCompanies(params) {
  return callCallRailApi(`/a/${encodeURIComponent(params.accountId)}/companies.json`, params.query, params.apiKey);
}

async function listCallRailCalls(params) {
  if (params.nextPageUrl) {
    return callCallRailApi(params.nextPageUrl, {}, params.apiKey);
  }
  return callCallRailApi(`/a/${encodeURIComponent(params.accountId)}/calls.json`, params.query, params.apiKey);
}

async function getCallRailCall(params) {
  return callCallRailApi(`/a/${encodeURIComponent(params.accountId)}/calls/${encodeURIComponent(params.callId)}.json`, params.query, params.apiKey);
}

async function getCallRailCallSummary(params) {
  return callCallRailApi(`/a/${encodeURIComponent(params.accountId)}/calls/summary.json`, params.query, params.apiKey);
}

async function getCallRailCallTimeseries(params) {
  return callCallRailApi(`/a/${encodeURIComponent(params.accountId)}/calls/timeseries.json`, params.query, params.apiKey);
}

async function listCallRailTrackers(params) {
  return callCallRailApi(`/a/${encodeURIComponent(params.accountId)}/trackers.json`, params.query, params.apiKey);
}

async function getCallRailResource(params) {
  return callCallRailApi(normalizeCallRailPath(params.path), params.query, params.apiKey);
}

function isToolCall(body) {
  return body?.method === "tools/call" && typeof body?.params?.name === "string";
}

function createServer(req) {
  const server = new McpServer({ name: "marketing-data-mcp", version: "1.3.0" });
  server.registerTool("list_marketing_presets", {
    title: "List Marketing Presets",
    description: "List expert Google Ads, GA4, and Search Console presets with their intended analyst use cases.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => buildToolResult(buildMarketingPresetCatalog()));
  server.registerTool("get_marketing_schema", {
    title: "Get Marketing Schema",
    description: "Return the normalized cross-platform marketing schema and field mapping guide.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => buildToolResult(NORMALIZED_MARKETING_SCHEMA));
  server.registerTool("list_marketing_guardrails", {
    title: "List Marketing Guardrails",
    description: "Return platform capability limits and truthfulness guardrails so analysis stays inside what each API can support.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => buildToolResult(buildMarketingGuardrailsPayload()));
  server.registerTool("normalize_marketing_records", {
    title: "Normalize Marketing Records",
    description: "Map arbitrary platform records into the normalized cross-platform marketing schema using supplied field-path mappings.",
    inputSchema: {
      platform: z.enum(["google_ads", "ga4", "search_console", "merchant_center", "callrail"]),
      preset: z.string().optional(),
      entityType: z.string().min(1),
      records: z.array(z.record(z.any())).min(1),
      mapping: z.object({
        sourcePrimaryKey: z.string().optional(),
        dimensions: z.record(z.string()).optional(),
        metrics: z.record(z.string()).optional(),
        sourceContext: z.record(z.string()).optional()
      }).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      platform: z.enum(["google_ads", "ga4", "search_console", "merchant_center", "callrail"]),
      preset: z.string().optional(),
      entityType: z.string().min(1),
      records: z.array(z.record(z.any())).min(1),
      mapping: z.object({
        sourcePrimaryKey: z.string().optional(),
        dimensions: z.record(z.string()).optional(),
        metrics: z.record(z.string()).optional(),
        sourceContext: z.record(z.string()).optional()
      }).optional()
    }).parse(params);
    const normalizedRecords = parsed.records.map((record) => buildNormalizedRecord({
      platform: parsed.platform,
      preset: parsed.preset || "custom_normalization",
      entityType: parsed.entityType,
      sourcePrimaryKey: parsed.mapping?.sourcePrimaryKey ? getNestedValue(record, parsed.mapping.sourcePrimaryKey) : undefined,
      dimensions: Object.fromEntries(
        Object.entries(parsed.mapping?.dimensions || {}).map(([key, path]) => [key, getNestedValue(record, path)])
      ),
      metrics: Object.fromEntries(
        Object.entries(parsed.mapping?.metrics || {}).map(([key, path]) => [key, toNumber(getNestedValue(record, path)) ?? getNestedValue(record, path)])
      ),
      sourceContext: Object.fromEntries(
        Object.entries(parsed.mapping?.sourceContext || {}).map(([key, path]) => [key, getNestedValue(record, path)])
      )
    }));
    return buildToolResult({
      normalizedSchema: NORMALIZED_MARKETING_SCHEMA,
      records: normalizedRecords
    });
  });
  server.registerTool("list_search_console_sites", {
    title: "List Search Console Sites",
    description: "List the Google Search Console sites accessible to the authenticated user.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_search_console_sites, async ({ googleCredentials }) => {
    const response = await listSearchConsoleSites(googleCredentials.accessToken);
    return buildToolResult(toGoogleDebugPayload(response), !response.ok);
  }));
  server.registerTool("query_search_console", {
    title: "Query Search Console",
    description: "Run a Search Console search analytics query against a verified site.",
    inputSchema: {
      siteUrl: z.string().min(1),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dimensions: z.array(z.string()).optional(),
      rowLimit: z.number().int().min(1).max(25000).optional(),
      startRow: z.number().int().min(0).optional(),
      aggregationType: z.enum(["auto", "byPage", "byProperty", "byNewsShowcasePanel"]).optional(),
      dataState: z.enum(["all", "final", "hourly_all"]).optional(),
      searchType: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional(),
      type: z.enum(["web", "image", "video", "discover", "googleNews", "news"]).optional(),
      dimensionFilterGroups: z.array(z.record(z.any())).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      siteUrl: z.string().min(1),
      startDate: z.string(),
      endDate: z.string(),
      dimensions: z.array(z.string()).optional(),
      rowLimit: z.number().int().optional(),
      startRow: z.number().int().optional(),
      aggregationType: z.string().optional(),
      dataState: z.string().optional(),
      searchType: z.string().optional(),
      type: z.string().optional(),
      dimensionFilterGroups: z.array(z.record(z.any())).optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.query_search_console, async ({ googleCredentials }) => {
      const response = await querySearchConsole(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("list_search_console_sitemaps", {
    title: "List Search Console Sitemaps",
    description: "List sitemaps submitted for a verified Search Console property.",
    inputSchema: {
      siteUrl: z.string().min(1)
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      siteUrl: z.string().min(1)
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_search_console_sitemaps, async ({ googleCredentials }) => {
      const response = await listSearchConsoleSitemaps(googleCredentials.accessToken, parsed.siteUrl);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_search_console_sitemap", {
    title: "Get Search Console Sitemap",
    description: "Get details for one Search Console sitemap feed path on a verified property.",
    inputSchema: {
      siteUrl: z.string().min(1),
      feedpath: z.string().min(1)
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      siteUrl: z.string().min(1),
      feedpath: z.string().min(1)
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.get_search_console_sitemap, async ({ googleCredentials }) => {
      const response = await getSearchConsoleSitemap(googleCredentials.accessToken, parsed.siteUrl, parsed.feedpath);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("inspect_search_console_url", {
    title: "Inspect Search Console URL",
    description: "Inspect Google index status for a single URL. This is the API alternative to aggregate Index Coverage UI data.",
    inputSchema: {
      siteUrl: z.string().min(1),
      inspectionUrl: z.string().url(),
      languageCode: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      siteUrl: z.string().min(1),
      inspectionUrl: z.string().url(),
      languageCode: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.inspect_search_console_url, async ({ googleCredentials }) => {
      const response = await inspectSearchConsoleUrl(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("run_search_console_preset", {
    title: "Run Search Console Preset",
    description: "Run expert Search Console reports: queries, pages, query-to-page pairs, striking-distance opportunities, countries, devices, country by device, date trends, per-day query and page movement, search appearance / rich results, branded versus non-branded, Discover, and Google News.",
    inputSchema: {
      preset: z.enum(SEARCH_CONSOLE_PRESET_NAMES),
      siteUrl: z.string().min(1),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      rowLimit: z.number().int().min(1).max(25000).optional(),
      startRow: z.number().int().min(0).optional(),
      aggregationType: z.enum(["auto", "byPage", "byProperty", "byNewsShowcasePanel"]).optional(),
      dataState: z.enum(["all", "final", "hourly_all"]).optional(),
      searchType: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional(),
      type: z.enum(["web", "image", "video", "discover", "googleNews", "news"]).optional(),
      secondaryDimension: z.enum(["country", "device", "page", "query"]).optional(),
      brandTerms: z.array(z.string()).optional(),
      brandMode: z.enum(["branded", "non_branded"]).optional(),
      minPosition: z.number().min(1).max(100).optional(),
      maxPosition: z.number().min(1).max(100).optional(),
      minImpressions: z.number().int().min(0).optional(),
      dimensionFilterGroups: z.array(z.record(z.any())).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      preset: z.enum(SEARCH_CONSOLE_PRESET_NAMES),
      siteUrl: z.string().min(1),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      rowLimit: z.number().int().min(1).max(25000).optional(),
      startRow: z.number().int().min(0).optional(),
      aggregationType: z.enum(["auto", "byPage", "byProperty", "byNewsShowcasePanel"]).optional(),
      dataState: z.enum(["all", "final", "hourly_all"]).optional(),
      searchType: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional(),
      type: z.enum(["web", "image", "video", "discover", "googleNews", "news"]).optional(),
      secondaryDimension: z.enum(["country", "device", "page", "query"]).optional(),
      brandTerms: z.array(z.string()).optional(),
      brandMode: z.enum(["branded", "non_branded"]).optional(),
      minPosition: z.number().min(1).max(100).optional(),
      maxPosition: z.number().min(1).max(100).optional(),
      minImpressions: z.number().int().min(0).optional(),
      dimensionFilterGroups: z.array(z.record(z.any())).optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.run_search_console_preset, async ({ googleCredentials }) => {
      let presetConfig;
      try {
        presetConfig = buildSearchConsolePresetRequest(parsed);
      } catch (error) {
        return buildToolResult({
          error: "invalid_search_console_preset_request",
          error_description: error instanceof Error ? error.message : String(error),
          preset: parsed.preset,
          presetCatalog: SEARCH_CONSOLE_PRESET_DEFINITIONS[parsed.preset] || null
        }, true);
      }
      const response = await querySearchConsole(googleCredentials.accessToken, presetConfig.request);
      const normalizedRows = response.ok
        ? normalizeSearchConsolePresetRows(parsed.preset, response.body, presetConfig.request.dimensions, presetConfig.postFilter)
        : [];
      return buildToolResult({
        preset: parsed.preset,
        entityType: presetConfig.entityType,
        dateRange: presetConfig.dateRange,
        notes: presetConfig.notes,
        postFilter: presetConfig.postFilter,
        rowCount: normalizedRows.length,
        guardrails: PLATFORM_GUARDRAILS.search_console,
        request: presetConfig.request,
        normalizedSchema: NORMALIZED_MARKETING_SCHEMA,
        normalizedRows,
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("compare_search_console_periods", {
    title: "Compare Search Console Periods",
    description: "Compare one Search Console dimension across two date ranges and return per-key deltas for clicks, impressions, CTR, and average position. Costs two Search Analytics requests.",
    inputSchema: {
      siteUrl: z.string().min(1),
      dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]).optional(),
      currentStartDate: z.string(),
      currentEndDate: z.string(),
      previousStartDate: z.string(),
      previousEndDate: z.string(),
      rowLimit: z.number().int().min(1).max(25000).optional(),
      type: z.enum(["web", "image", "video", "discover", "googleNews", "news"]).optional(),
      dimensionFilterGroups: z.array(z.record(z.any())).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      siteUrl: z.string().min(1),
      dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]).optional(),
      currentStartDate: z.string(),
      currentEndDate: z.string(),
      previousStartDate: z.string(),
      previousEndDate: z.string(),
      rowLimit: z.number().int().min(1).max(25000).optional(),
      type: z.enum(["web", "image", "video", "discover", "googleNews", "news"]).optional(),
      dimensionFilterGroups: z.array(z.record(z.any())).optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.compare_search_console_periods, async ({ googleCredentials }) => {
      const dimension = parsed.dimension || "query";
      const baseRequest = {
        siteUrl: parsed.siteUrl,
        dimensions: [dimension],
        rowLimit: parsed.rowLimit || 1000,
        type: parsed.type,
        dimensionFilterGroups: parsed.dimensionFilterGroups?.length ? parsed.dimensionFilterGroups : undefined
      };
      const [current, previous] = await Promise.all([
        querySearchConsole(googleCredentials.accessToken, { ...baseRequest, startDate: parsed.currentStartDate, endDate: parsed.currentEndDate }),
        querySearchConsole(googleCredentials.accessToken, { ...baseRequest, startDate: parsed.previousStartDate, endDate: parsed.previousEndDate })
      ]);
      if (!current.ok || !previous.ok) {
        return buildToolResult({
          error: "search_console_comparison_failed",
          current: toGoogleDebugPayload(current),
          previous: toGoogleDebugPayload(previous)
        }, true);
      }
      const index = (body) => new Map(
        buildSearchConsoleRowObjects(body, [dimension]).map((row) => [row[dimension], row])
      );
      const currentRows = index(current.body);
      const previousRows = index(previous.body);
      const keys = new Set([...currentRows.keys(), ...previousRows.keys()]);
      const delta = (a, b) => (a === undefined && b === undefined ? undefined : (toNumber(a) || 0) - (toNumber(b) || 0));
      const comparisons = [...keys].map((key) => {
        const now = currentRows.get(key) || {};
        const before = previousRows.get(key) || {};
        return {
          key,
          dimension,
          current: { clicks: toNumber(now.clicks) || 0, impressions: toNumber(now.impressions) || 0, ctr: toNumber(now.ctr) || 0, position: toNumber(now.position) ?? null },
          previous: { clicks: toNumber(before.clicks) || 0, impressions: toNumber(before.impressions) || 0, ctr: toNumber(before.ctr) || 0, position: toNumber(before.position) ?? null },
          change: {
            clicks: delta(now.clicks, before.clicks),
            impressions: delta(now.impressions, before.impressions),
            ctr: delta(now.ctr, before.ctr),
            // Position improves as it falls, so invert the sign: positive means moved up.
            position: now.position !== undefined && before.position !== undefined
              ? (toNumber(before.position) - toNumber(now.position))
              : undefined
          },
          status: currentRows.has(key) && previousRows.has(key) ? "both" : currentRows.has(key) ? "new" : "lost"
        };
      }).sort((a, b) => (b.change.clicks || 0) - (a.change.clicks || 0));
      return buildToolResult({
        dimension,
        currentRange: { startDate: parsed.currentStartDate, endDate: parsed.currentEndDate },
        previousRange: { startDate: parsed.previousStartDate, endDate: parsed.previousEndDate },
        rowCount: comparisons.length,
        requestCount: 2,
        guardrails: PLATFORM_GUARDRAILS.search_console,
        comparisons
      });
    });
  });
  server.registerTool("list_ga4_properties", {
    title: "List GA4 Properties",
    description: "List GA4 properties available to the authenticated user.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_ga4_properties, async ({ googleCredentials }) => {
    const response = await listGa4Properties(googleCredentials.accessToken);
    return buildToolResult(toGoogleDebugPayload(response), !response.ok);
  }));
  server.registerTool("run_ga4_report", {
    title: "Run GA4 Report",
    description: "Run a GA4 Data API report for a property the authenticated user can access.",
    inputSchema: {
      propertyId: z.string().min(1),
      dateRanges: z.array(z.object({ startDate: z.string(), endDate: z.string() })),
      dimensions: z.array(z.object({ name: z.string().min(1) })).optional(),
      metrics: z.array(z.object({ name: z.string().min(1) })).min(1),
      dimensionFilter: z.record(z.any()).optional(),
      metricFilter: z.record(z.any()).optional(),
      offset: z.string().optional(),
      limit: z.string().optional(),
      metricAggregations: z.array(z.string()).optional(),
      orderBys: z.array(z.record(z.any())).optional(),
      currencyCode: z.string().optional(),
      cohortSpec: z.record(z.any()).optional(),
      keepEmptyRows: z.boolean().optional(),
      returnPropertyQuota: z.boolean().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1),
      dateRanges: z.array(z.object({ startDate: z.string(), endDate: z.string() })),
      dimensions: z.array(z.object({ name: z.string().min(1) })).optional(),
      metrics: z.array(z.object({ name: z.string().min(1) })).min(1),
      dimensionFilter: z.record(z.any()).optional(),
      metricFilter: z.record(z.any()).optional(),
      offset: z.string().optional(),
      limit: z.string().optional(),
      metricAggregations: z.array(z.string()).optional(),
      orderBys: z.array(z.record(z.any())).optional(),
      currencyCode: z.string().optional(),
      cohortSpec: z.record(z.any()).optional(),
      keepEmptyRows: z.boolean().optional(),
      returnPropertyQuota: z.boolean().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.run_ga4_report, async ({ googleCredentials }) => {
      const response = await runGa4Report(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_ga4_metadata", {
    title: "Get GA4 Metadata",
    description: "List GA4 dimensions and metrics available for a property, including custom definitions and compatibility metadata.",
    inputSchema: {
      propertyId: z.string().min(1)
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1)
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.get_ga4_metadata, async ({ googleCredentials }) => {
      const response = await getGa4Metadata(googleCredentials.accessToken, parsed.propertyId);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("check_ga4_compatibility", {
    title: "Check GA4 Compatibility",
    description: "Validate whether a GA4 dimension and metric set can be queried together before running a report.",
    inputSchema: {
      propertyId: z.string().min(1),
      dimensions: z.array(z.object({ name: z.string().min(1) })).optional(),
      metrics: z.array(z.object({ name: z.string().min(1) })).optional(),
      dimensionFilter: z.record(z.any()).optional(),
      metricFilter: z.record(z.any()).optional(),
      compatibilityFilter: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1),
      dimensions: z.array(z.object({ name: z.string().min(1) })).optional(),
      metrics: z.array(z.object({ name: z.string().min(1) })).optional(),
      dimensionFilter: z.record(z.any()).optional(),
      metricFilter: z.record(z.any()).optional(),
      compatibilityFilter: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.check_ga4_compatibility, async ({ googleCredentials }) => {
      const response = await checkGa4Compatibility(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("batch_run_ga4_reports", {
    title: "Batch Run GA4 Reports",
    description: "Run multiple GA4 core reports in one request.",
    inputSchema: {
      propertyId: z.string().min(1),
      requests: z.array(z.record(z.any())).min(1)
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1),
      requests: z.array(z.record(z.any())).min(1)
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.batch_run_ga4_reports, async ({ googleCredentials }) => {
      const response = await batchRunGa4Reports(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("run_ga4_realtime_report", {
    title: "Run GA4 Realtime Report",
    description: "Run a GA4 realtime report for live users, sources, channels, campaigns, and events.",
    inputSchema: {
      propertyId: z.string().min(1),
      dimensions: z.array(z.object({ name: z.string().min(1) })).optional(),
      metrics: z.array(z.object({ name: z.string().min(1) })).min(1),
      dimensionFilter: z.record(z.any()).optional(),
      metricFilter: z.record(z.any()).optional(),
      limit: z.string().optional(),
      minuteRanges: z.array(z.record(z.any())).optional(),
      orderBys: z.array(z.record(z.any())).optional(),
      returnPropertyQuota: z.boolean().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1),
      dimensions: z.array(z.object({ name: z.string().min(1) })).optional(),
      metrics: z.array(z.object({ name: z.string().min(1) })).min(1),
      dimensionFilter: z.record(z.any()).optional(),
      metricFilter: z.record(z.any()).optional(),
      limit: z.string().optional(),
      minuteRanges: z.array(z.record(z.any())).optional(),
      orderBys: z.array(z.record(z.any())).optional(),
      returnPropertyQuota: z.boolean().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.run_ga4_realtime_report, async ({ googleCredentials }) => {
      const response = await runGa4RealtimeReport(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("run_ga4_pivot_report", {
    title: "Run GA4 Pivot Report",
    description: "Run a GA4 pivot report for channel, attribution, landing page, country, device, or other pivoted breakdowns.",
    inputSchema: {
      propertyId: z.string().min(1),
      dateRanges: z.array(z.object({ startDate: z.string(), endDate: z.string() })),
      pivots: z.array(z.record(z.any())).min(1),
      dimensions: z.array(z.object({ name: z.string().min(1) })).optional(),
      metrics: z.array(z.object({ name: z.string().min(1) })).min(1),
      dimensionFilter: z.record(z.any()).optional(),
      metricFilter: z.record(z.any()).optional(),
      currencyCode: z.string().optional(),
      cohortSpec: z.record(z.any()).optional(),
      keepEmptyRows: z.boolean().optional(),
      returnPropertyQuota: z.boolean().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1),
      dateRanges: z.array(z.object({ startDate: z.string(), endDate: z.string() })),
      pivots: z.array(z.record(z.any())).min(1),
      dimensions: z.array(z.object({ name: z.string().min(1) })).optional(),
      metrics: z.array(z.object({ name: z.string().min(1) })).min(1),
      dimensionFilter: z.record(z.any()).optional(),
      metricFilter: z.record(z.any()).optional(),
      currencyCode: z.string().optional(),
      cohortSpec: z.record(z.any()).optional(),
      keepEmptyRows: z.boolean().optional(),
      returnPropertyQuota: z.boolean().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.run_ga4_pivot_report, async ({ googleCredentials }) => {
      const response = await runGa4PivotReport(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("run_ga4_preset", {
    title: "Run GA4 Preset",
    description: "Run expert GA4 reports: traffic and user acquisition, channels, campaigns, Google Ads with cost and ROAS, landing pages, pages and screens, events, key events, ecommerce and item performance, item lists, promotions, the ecommerce funnel, demographics, technology, new versus returning, audiences, site search, engagement, and daily trends. Call list_marketing_presets for the full catalogue.",
    inputSchema: {
      preset: z.enum(GA4_PRESET_NAMES),
      propertyId: z.string().min(1),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().int().min(1).max(250000).optional(),
      offset: z.number().int().min(0).optional(),
      includeDailyBreakdown: z.boolean().optional(),
      conversionMetric: z.enum(["keyEvents", "conversions"]).optional(),
      dimensionFilter: z.record(z.any()).optional(),
      metricFilter: z.record(z.any()).optional(),
      orderBys: z.array(z.record(z.any())).optional(),
      keepEmptyRows: z.boolean().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      preset: z.enum(GA4_PRESET_NAMES),
      propertyId: z.string().min(1),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().int().min(1).max(250000).optional(),
      offset: z.number().int().min(0).optional(),
      includeDailyBreakdown: z.boolean().optional(),
      conversionMetric: z.enum(["keyEvents", "conversions"]).optional(),
      dimensionFilter: z.record(z.any()).optional(),
      metricFilter: z.record(z.any()).optional(),
      orderBys: z.array(z.record(z.any())).optional(),
      keepEmptyRows: z.boolean().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.run_ga4_preset, async ({ googleCredentials }) => {
      let presetConfig;
      try {
        presetConfig = buildGa4PresetRequest(parsed);
      } catch (error) {
        return buildToolResult({
          error: "invalid_ga4_preset_request",
          error_description: error instanceof Error ? error.message : String(error),
          preset: parsed.preset,
          presetCatalog: GA4_PRESET_DEFINITIONS[parsed.preset] || null
        }, true);
      }
      const response = await runGa4Report(googleCredentials.accessToken, presetConfig.request);
      return buildToolResult({
        preset: parsed.preset,
        entityType: presetConfig.entityType,
        dateRange: presetConfig.dateRange,
        conversionMetric: presetConfig.conversionMetric,
        notes: presetConfig.notes,
        rowCount: response.ok ? response.body?.rowCount ?? null : null,
        guardrails: PLATFORM_GUARDRAILS.ga4,
        request: presetConfig.request,
        normalizedSchema: NORMALIZED_MARKETING_SCHEMA,
        normalizedRows: response.ok ? normalizeGa4PresetRows(parsed.preset, response.body) : [],
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("run_ga4_funnel_report", {
    title: "Run GA4 Funnel Report",
    description: "Run a GA4 funnel report with ordered or open funnel steps, optional breakdown dimension, and next-action analysis. Funnel reporting lives on the Data API v1alpha surface, so the response shape differs from runReport.",
    inputSchema: {
      propertyId: z.string().min(1),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      funnel: z.record(z.any()),
      funnelBreakdown: z.record(z.any()).optional(),
      funnelNextAction: z.record(z.any()).optional(),
      funnelVisualizationType: z.enum(["STANDARD_FUNNEL", "TRENDED_FUNNEL"]).optional(),
      segments: z.array(z.record(z.any())).optional(),
      dimensionFilter: z.record(z.any()).optional(),
      limit: z.number().int().min(1).max(100000).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      funnel: z.record(z.any()),
      funnelBreakdown: z.record(z.any()).optional(),
      funnelNextAction: z.record(z.any()).optional(),
      funnelVisualizationType: z.enum(["STANDARD_FUNNEL", "TRENDED_FUNNEL"]).optional(),
      segments: z.array(z.record(z.any())).optional(),
      dimensionFilter: z.record(z.any()).optional(),
      limit: z.number().int().min(1).max(100000).optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.run_ga4_funnel_report, async ({ googleCredentials }) => {
      const dateRange = resolveDateWindow(parsed);
      const response = await runGa4FunnelReport(googleCredentials.accessToken, {
        propertyId: parsed.propertyId,
        dateRanges: [{ startDate: dateRange.startDate, endDate: dateRange.endDate }],
        funnel: parsed.funnel,
        funnelBreakdown: parsed.funnelBreakdown,
        funnelNextAction: parsed.funnelNextAction,
        funnelVisualizationType: parsed.funnelVisualizationType,
        segments: parsed.segments,
        dimensionFilter: parsed.dimensionFilter,
        limit: parsed.limit ? String(parsed.limit) : undefined
      });
      return buildToolResult({
        dateRange,
        apiSurface: "analyticsdata.googleapis.com/v1alpha:runFunnelReport",
        guardrails: PLATFORM_GUARDRAILS.ga4,
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("run_ga4_cohort_report", {
    title: "Run GA4 Cohort Report",
    description: "Run a GA4 cohort retention report. Supply cohortSpec directly, or let the tool build a rolling weekly or daily cohort series from the date range.",
    inputSchema: {
      propertyId: z.string().min(1),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      granularity: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).optional(),
      cohortCount: z.number().int().min(1).max(12).optional(),
      metrics: z.array(z.string()).optional(),
      cohortSpec: z.record(z.any()).optional(),
      limit: z.number().int().min(1).max(100000).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      granularity: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).optional(),
      cohortCount: z.number().int().min(1).max(12).optional(),
      metrics: z.array(z.string()).optional(),
      cohortSpec: z.record(z.any()).optional(),
      limit: z.number().int().min(1).max(100000).optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.run_ga4_cohort_report, async ({ googleCredentials }) => {
      const dateRange = resolveDateWindow(parsed);
      const granularity = parsed.granularity || "WEEKLY";
      const stepDays = granularity === "DAILY" ? 1 : granularity === "MONTHLY" ? 30 : 7;
      const cohortCount = parsed.cohortCount || 4;
      const cohortSpec = parsed.cohortSpec || {
        cohorts: Array.from({ length: cohortCount }, (_unused, index) => {
          const cohortStart = shiftDays(dateRange.startDate, index * stepDays);
          const cohortEnd = shiftDays(cohortStart, stepDays - 1);
          return {
            name: `cohort_${index}`,
            dimension: "firstSessionDate",
            dateRange: { startDate: cohortStart, endDate: cohortEnd > dateRange.endDate ? dateRange.endDate : cohortEnd }
          };
        }),
        cohortsRange: { granularity, startOffset: 0, endOffset: cohortCount - 1 }
      };
      const response = await runGa4Report(googleCredentials.accessToken, {
        propertyId: parsed.propertyId,
        dimensions: [{ name: "cohort" }, { name: "cohortNthDay" }],
        metrics: (parsed.metrics || ["cohortActiveUsers", "cohortTotalUsers"]).map((name) => ({ name })),
        cohortSpec,
        limit: parsed.limit ? String(parsed.limit) : undefined
      });
      return buildToolResult({
        dateRange,
        granularity,
        cohortSpec,
        guardrails: PLATFORM_GUARDRAILS.ga4,
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("list_ga4_custom_definitions", {
    title: "List GA4 Custom Definitions",
    description: "List the custom dimensions or custom metrics configured on a GA4 property, so reports can reference the right customEvent: or customUser: field names.",
    inputSchema: {
      propertyId: z.string().min(1),
      type: z.enum(["dimensions", "metrics"]).optional(),
      pageSize: z.number().int().min(1).max(200).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1),
      type: z.enum(["dimensions", "metrics"]).optional(),
      pageSize: z.number().int().min(1).max(200).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_ga4_custom_definitions, async ({ googleCredentials }) => {
      const resource = parsed.type === "metrics" ? "customMetrics" : "customDimensions";
      const response = await listGa4AdminResource(googleCredentials.accessToken, parsed.propertyId, resource, parsed);
      return buildToolResult({
        propertyId: normalizePropertyName(parsed.propertyId),
        resource,
        guardrails: PLATFORM_GUARDRAILS.ga4,
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("list_ga4_key_events", {
    title: "List GA4 Key Events",
    description: "List the key events (formerly conversion events) configured on a GA4 property, including counting method and default value.",
    inputSchema: {
      propertyId: z.string().min(1),
      pageSize: z.number().int().min(1).max(200).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1),
      pageSize: z.number().int().min(1).max(200).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_ga4_key_events, async ({ googleCredentials }) => {
      const response = await listGa4AdminResource(googleCredentials.accessToken, parsed.propertyId, "keyEvents", parsed);
      return buildToolResult({
        propertyId: normalizePropertyName(parsed.propertyId),
        guardrails: PLATFORM_GUARDRAILS.ga4,
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("list_ga4_data_streams", {
    title: "List GA4 Data Streams",
    description: "List the web and app data streams on a GA4 property, including measurement IDs and stream URLs, for measurement health checks.",
    inputSchema: {
      propertyId: z.string().min(1),
      pageSize: z.number().int().min(1).max(200).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      propertyId: z.string().min(1),
      pageSize: z.number().int().min(1).max(200).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_ga4_data_streams, async ({ googleCredentials }) => {
      const response = await listGa4AdminResource(googleCredentials.accessToken, parsed.propertyId, "dataStreams", parsed);
      return buildToolResult({
        propertyId: normalizePropertyName(parsed.propertyId),
        guardrails: PLATFORM_GUARDRAILS.ga4,
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("list_merchant_accounts", {
    title: "List Merchant Center Accounts",
    description: "List Merchant Center accounts accessible to the authenticated Google user.",
    inputSchema: {
      pageSize: z.number().int().min(1).max(500).optional(),
      pageToken: z.string().optional(),
      filter: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      pageSize: z.number().int().min(1).max(500).optional(),
      pageToken: z.string().optional(),
      filter: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_merchant_accounts, async ({ googleCredentials }) => {
      const response = await listMerchantAccounts(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_merchant_account", {
    title: "Get Merchant Center Account",
    description: "Get a Merchant Center account by account resource name or numeric account ID.",
    inputSchema: {
      name: z.string().min(1)
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      name: z.string().min(1)
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.get_merchant_account, async ({ googleCredentials }) => {
      const response = await getMerchantAccount(googleCredentials.accessToken, parsed.name);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("list_merchant_products", {
    title: "List Merchant Center Products",
    description: "List processed products for a Merchant Center account.",
    inputSchema: {
      accountId: z.string().min(1),
      pageSize: z.number().int().min(1).max(250).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      pageSize: z.number().int().min(1).max(250).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_merchant_products, async ({ googleCredentials }) => {
      const response = await listMerchantProducts(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_merchant_product", {
    title: "Get Merchant Center Product",
    description: "Get a processed Merchant Center product by full resource name, for example accounts/123/products/en~US~sku123.",
    inputSchema: {
      name: z.string().min(1)
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      name: z.string().min(1)
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.get_merchant_product, async ({ googleCredentials }) => {
      const response = await getMerchantProduct(googleCredentials.accessToken, parsed.name);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("search_merchant_reports", {
    title: "Search Merchant Center Reports",
    description: "Run Merchant Center report queries for product performance, competitive visibility, price benchmarks, and other reporting datasets.",
    inputSchema: {
      accountId: z.string().min(1),
      query: z.string().min(1),
      pageSize: z.number().int().min(1).max(1000).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      query: z.string().min(1),
      pageSize: z.number().int().min(1).max(1000).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.search_merchant_reports, async ({ googleCredentials }) => {
      const response = await searchMerchantReports(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_merchant_developer_registration", {
    title: "Get Merchant Center Developer Registration",
    description: "Check whether this server's Google Cloud project is registered as a Merchant API developer for an account. Merchant API returns GCP_NOT_REGISTERED for every other call until it is.",
    inputSchema: {
      accountId: z.string().min(1)
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1)
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.get_merchant_developer_registration, async ({ googleCredentials }) => {
      const response = await getMerchantDeveloperRegistration(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("register_merchant_developer", {
    title: "Register Merchant Center Developer (write)",
    description: "Register this server's Google Cloud project as a Merchant API developer for one Merchant Center account, which is required before any other Merchant API call will succeed. This WRITES to the Merchant Center account: it grants the API_DEVELOPER role to developerEmail if that address is already a user on the account, and otherwise sends that address an invitation that must be accepted. Prefer an email that already has access to the account. Registration takes about 5 minutes to take effect and can be undone in Merchant Center.",
    inputSchema: {
      accountId: z.string().min(1),
      developerEmail: z.string().email()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      developerEmail: z.string().email()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.register_merchant_developer, async ({ googleCredentials }) => {
      const response = await registerMerchantDeveloper(googleCredentials.accessToken, parsed);
      return buildToolResult({
        accountId: parsed.accountId,
        developerEmail: parsed.developerEmail,
        registered: response.ok,
        note: response.ok
          ? "Registered. Merchant API calls for this account should start working in about 5 minutes."
          : "Registration failed. See raw for the API error.",
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("list_merchant_subaccounts", {
    title: "List Merchant Center Subaccounts",
    description: "List subaccounts under a Merchant Center advanced (multi-client) account.",
    inputSchema: {
      accountId: z.string().min(1),
      pageSize: z.number().int().min(1).max(500).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      pageSize: z.number().int().min(1).max(500).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_merchant_subaccounts, async ({ googleCredentials }) => {
      const response = await listMerchantSubaccounts(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_merchant_account_issues", {
    title: "Get Merchant Center Account Issues",
    description: "List account-level Merchant Center issues such as website claim problems, policy warnings, and suspensions.",
    inputSchema: {
      accountId: z.string().min(1),
      languageCode: z.string().optional(),
      timeZone: z.string().optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      languageCode: z.string().optional(),
      timeZone: z.string().optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.get_merchant_account_issues, async ({ googleCredentials }) => {
      const response = await getMerchantAccountIssues(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_merchant_product_status_summary", {
    title: "Get Merchant Center Product Status Summary",
    description: "Aggregate product status counts and the issues affecting them, grouped by reporting context. Use this to diagnose why products are disapproved or limited.",
    inputSchema: {
      accountId: z.string().min(1),
      filter: z.string().optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      filter: z.string().optional(),
      pageSize: z.number().int().min(1).max(500).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.get_merchant_product_status_summary, async ({ googleCredentials }) => {
      const response = await getMerchantProductStatusSummary(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("list_merchant_data_sources", {
    title: "List Merchant Center Data Sources",
    description: "List product feeds and other data sources configured for a Merchant Center account, including their input type and update schedule.",
    inputSchema: {
      accountId: z.string().min(1),
      pageSize: z.number().int().min(1).max(500).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      pageSize: z.number().int().min(1).max(500).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_merchant_data_sources, async ({ googleCredentials }) => {
      const response = await listMerchantDataSources(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("run_merchant_preset", {
    title: "Run Merchant Center Preset",
    description: "Run expert Merchant Center reports: product, brand, category and country performance, feed status and item issues, price competitiveness, price insights, best-selling product clusters and brands, non-product traffic, and competitive visibility including the category benchmark and top merchants. Product performance with marketingMethod ORGANIC covers free listings and needs no Google Ads account.",
    inputSchema: {
      preset: z.enum(MERCHANT_PRESET_NAMES),
      accountId: z.string().min(1),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
      marketingMethod: z.enum(["ORGANIC", "ADS"]).optional(),
      reportCountryCode: z.string().optional(),
      reportCategoryId: z.string().optional(),
      reportDate: z.string().optional(),
      reportGranularity: z.enum(["WEEKLY", "MONTHLY"]).optional(),
      aggregatedStatus: z.string().optional(),
      includeItemIssues: z.boolean().optional(),
      includeDailyBreakdown: z.boolean().optional(),
      orderBy: z.string().optional(),
      extraWhereClauses: z.array(z.string()).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      preset: z.enum(MERCHANT_PRESET_NAMES),
      accountId: z.string().min(1),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
      marketingMethod: z.enum(["ORGANIC", "ADS"]).optional(),
      reportCountryCode: z.string().optional(),
      reportCategoryId: z.string().optional(),
      reportDate: z.string().optional(),
      reportGranularity: z.enum(["WEEKLY", "MONTHLY"]).optional(),
      aggregatedStatus: z.string().optional(),
      includeItemIssues: z.boolean().optional(),
      includeDailyBreakdown: z.boolean().optional(),
      orderBy: z.string().optional(),
      extraWhereClauses: z.array(z.string()).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.run_merchant_preset, async ({ googleCredentials }) => {
      const presetConfig = buildMerchantPresetQuery(parsed);
      const response = await searchMerchantReports(googleCredentials.accessToken, {
        accountId: parsed.accountId,
        query: presetConfig.query,
        pageSize: parsed.pageSize || parsed.limit,
        pageToken: parsed.pageToken
      });
      return buildToolResult({
        preset: parsed.preset,
        entityType: presetConfig.entityType,
        view: presetConfig.view,
        dateRange: presetConfig.timeSeries ? presetConfig.dateRange : null,
        isSnapshot: !presetConfig.timeSeries,
        guardrails: PLATFORM_GUARDRAILS.merchant_center,
        query: presetConfig.query,
        normalizedSchema: NORMALIZED_MARKETING_SCHEMA,
        normalizedRows: response.ok ? normalizeMerchantPresetRows(parsed.preset, response.body) : [],
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("list_google_ads_accessible_customers", {
    title: "List Google Ads Accessible Customers",
    description: "List Google Ads customer resource names available to the authenticated Google user.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_google_ads_accessible_customers, async ({ googleCredentials }) => {
    const response = await listGoogleAdsAccessibleCustomers(googleCredentials.accessToken);
    return buildToolResult(toGoogleDebugPayload(response), !response.ok);
  }));
  server.registerTool("query_google_ads", {
    title: "Query Google Ads",
    description: "Run a GAQL query against a Google Ads customer. Use this for campaigns, ad groups, ads, keywords, assets, conversions, placements, audiences, search terms, and reporting.",
    inputSchema: {
      customerId: z.string().min(1),
      query: z.string().min(1),
      loginCustomerId: z.string().optional(),
      pageSize: z.number().int().min(1).max(10000).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      customerId: z.string().min(1),
      query: z.string().min(1),
      loginCustomerId: z.string().optional(),
      pageSize: z.number().int().min(1).max(10000).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.query_google_ads, async ({ googleCredentials }) => {
      const response = await queryGoogleAds(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("search_stream_google_ads", {
    title: "Search Stream Google Ads",
    description: "Run a streamed GAQL query for large Google Ads result sets.",
    inputSchema: {
      customerId: z.string().min(1),
      query: z.string().min(1),
      loginCustomerId: z.string().optional(),
      summaryRowSetting: z.enum(["NO_SUMMARY_ROW", "SUMMARY_ROW_WITH_RESULTS", "SUMMARY_ROW_ONLY"]).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      customerId: z.string().min(1),
      query: z.string().min(1),
      loginCustomerId: z.string().optional(),
      summaryRowSetting: z.enum(["NO_SUMMARY_ROW", "SUMMARY_ROW_WITH_RESULTS", "SUMMARY_ROW_ONLY"]).optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.search_stream_google_ads, async ({ googleCredentials }) => {
      const response = await searchStreamGoogleAds(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_google_ads_field", {
    title: "Get Google Ads Field",
    description: "Get metadata for a Google Ads field or resource, including whether it is selectable, filterable, sortable, and repeated.",
    inputSchema: {
      name: z.string().min(1)
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      name: z.string().min(1)
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.get_google_ads_field, async ({ googleCredentials }) => {
      const response = await getGoogleAdsField(googleCredentials.accessToken, parsed.name);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("search_google_ads_fields", {
    title: "Search Google Ads Fields",
    description: "Search Google Ads field metadata so you can discover valid attributes, segments, metrics, and filters before writing GAQL.",
    inputSchema: {
      query: z.string().min(1),
      pageSize: z.number().int().min(1).max(1000).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      query: z.string().min(1),
      pageSize: z.number().int().min(1).max(1000).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.search_google_ads_fields, async ({ googleCredentials }) => {
      const response = await searchGoogleAdsFields(googleCredentials.accessToken, parsed);
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("run_google_ads_preset", {
    title: "Run Google Ads Preset",
    description: "Run expert Google Ads reports via GAQL. Covers campaigns, ad groups, keywords, search terms, ads, assets, impression share, Quality Score, Shopping, Performance Max, geo, device, ad schedule, demographics, audiences, placements, conversion actions, landing pages, budgets, bidding strategies, video, calls, account overview, negative keywords, change history, recommendations, experiments, and GCLID click detail. Call list_marketing_presets for the full catalogue. Each call is exactly one Google Ads API request, which matters on a Basic Access developer token.",
    inputSchema: {
      preset: z.enum(GOOGLE_ADS_PRESET_NAMES),
      customerId: z.string().min(1),
      loginCustomerId: z.string().optional(),
      campaignId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().int().min(1).max(100000).optional(),
      includeDailyBreakdown: z.boolean().optional(),
      includeImpressionShare: z.boolean().optional(),
      includeQualityScore: z.boolean().optional(),
      orderBy: z.string().optional(),
      extraWhereClauses: z.array(z.string()).optional(),
      pageToken: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      preset: z.enum(GOOGLE_ADS_PRESET_NAMES),
      customerId: z.string().min(1),
      loginCustomerId: z.string().optional(),
      campaignId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().int().min(1).max(100000).optional(),
      includeDailyBreakdown: z.boolean().optional(),
      includeImpressionShare: z.boolean().optional(),
      includeQualityScore: z.boolean().optional(),
      orderBy: z.string().optional(),
      extraWhereClauses: z.array(z.string()).optional(),
      pageToken: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.run_google_ads_preset, async ({ googleCredentials }) => {
      let presetConfig;
      try {
        presetConfig = buildGoogleAdsPresetQuery(parsed);
      } catch (error) {
        return buildToolResult({
          error: "invalid_google_ads_preset_request",
          error_description: error instanceof Error ? error.message : String(error),
          preset: parsed.preset,
          presetCatalog: GOOGLE_ADS_PRESET_DEFINITIONS[parsed.preset] || null
        }, true);
      }
      const response = await queryGoogleAds(googleCredentials.accessToken, {
        customerId: parsed.customerId,
        loginCustomerId: parsed.loginCustomerId,
        query: presetConfig.query,
        pageSize: presetConfig.pageSize,
        pageToken: parsed.pageToken
      });
      return buildToolResult({
        preset: parsed.preset,
        entityType: presetConfig.entityType,
        resource: presetConfig.resource,
        timeSeries: presetConfig.timeSeries,
        dateRange: presetConfig.dateRange,
        limit: presetConfig.limit,
        pageSize: presetConfig.pageSize,
        nextPageToken: response.ok ? response.body?.nextPageToken || null : null,
        notes: presetConfig.notes,
        guardrails: PLATFORM_GUARDRAILS.google_ads,
        gaql: presetConfig.query,
        normalizedSchema: NORMALIZED_MARKETING_SCHEMA,
        normalizedRows: response.ok ? normalizeGoogleAdsPresetRows(parsed.preset, response.body) : [],
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("list_google_ads_customer_clients", {
    title: "List Google Ads Customer Clients",
    description: "Walk a Google Ads manager (MCC) account tree in a single request and return every child account with id, name, currency, time zone, level, and manager flag. Use this when listAccessibleCustomers only returns the manager account.",
    inputSchema: {
      customerId: z.string().min(1),
      loginCustomerId: z.string().optional(),
      includeDisabled: z.boolean().optional(),
      maxLevel: z.number().int().min(0).max(10).optional(),
      limit: z.number().int().min(1).max(10000).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      customerId: z.string().min(1),
      loginCustomerId: z.string().optional(),
      includeDisabled: z.boolean().optional(),
      maxLevel: z.number().int().min(0).max(10).optional(),
      limit: z.number().int().min(1).max(10000).optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_google_ads_customer_clients, async ({ googleCredentials }) => {
      const clauses = [];
      if (!parsed.includeDisabled) clauses.push("customer_client.status = 'ENABLED'");
      if (parsed.maxLevel !== undefined) clauses.push(`customer_client.level <= ${parsed.maxLevel}`);
      const whereSql = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const limit = parsed.limit || 1000;
      const query = `SELECT customer_client.id, customer_client.client_customer, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.level, customer_client.manager, customer_client.status, customer_client.test_account FROM customer_client${whereSql} ORDER BY customer_client.level ASC LIMIT ${limit}`;
      const response = await queryGoogleAds(googleCredentials.accessToken, {
        customerId: parsed.customerId,
        loginCustomerId: parsed.loginCustomerId,
        query,
        pageSize: Math.min(limit, GOOGLE_ADS_MAX_PAGE_SIZE)
      });
      const accounts = response.ok
        ? (response.body?.results || []).map((row) => ({
            customerId: getGoogleAdsValue(row, "customer_client.id"),
            resourceName: getGoogleAdsValue(row, "customer_client.client_customer"),
            name: getGoogleAdsValue(row, "customer_client.descriptive_name"),
            currency: getGoogleAdsValue(row, "customer_client.currency_code"),
            timeZone: getGoogleAdsValue(row, "customer_client.time_zone"),
            level: toNumber(getGoogleAdsValue(row, "customer_client.level")),
            isManager: getGoogleAdsValue(row, "customer_client.manager") === true,
            isTestAccount: getGoogleAdsValue(row, "customer_client.test_account") === true,
            status: getGoogleAdsValue(row, "customer_client.status")
          }))
        : [];
      return buildToolResult({
        managerCustomerId: normalizeGoogleAdsCustomerId(parsed.customerId),
        accountCount: accounts.length,
        accounts,
        gaql: query,
        guardrails: PLATFORM_GUARDRAILS.google_ads,
        raw: toGoogleDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("list_callrail_accounts", {
    title: "List CallRail Accounts",
    description: "List CallRail accounts visible to the configured CallRail API token.",
    inputSchema: {
      query: z.record(z.any()).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      query: z.record(z.any()).optional()
    }).parse(params);
    return withCallRailTool(req, "list_callrail_accounts", async ({ apiKey }) => {
      const response = await listCallRailAccounts({ ...parsed, apiKey });
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("list_callrail_companies", {
    title: "List CallRail Companies",
    description: "List CallRail companies for an account visible to the configured CallRail API token.",
    inputSchema: {
      accountId: z.string().min(1),
      query: z.record(z.any()).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      query: z.record(z.any()).optional()
    }).parse(params);
    return withCallRailTool(req, "list_callrail_companies", async ({ apiKey }) => {
      const response = await listCallRailCompanies({ ...parsed, apiKey });
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("list_callrail_calls", {
    title: "List CallRail Calls",
    description: "List CallRail calls for an account. Pass documented API query params via query, or pass nextPageUrl from a previous response for relative pagination.",
    inputSchema: {
      accountId: z.string().min(1).optional(),
      nextPageUrl: z.string().url().optional(),
      query: z.record(z.any()).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1).optional(),
      nextPageUrl: z.string().url().optional(),
      query: z.record(z.any()).optional()
    }).parse(params);
    if (!parsed.accountId && !parsed.nextPageUrl) {
      return buildToolResult({
        error: "invalid_request",
        error_description: "Provide accountId or nextPageUrl."
      }, true);
    }
    return withCallRailTool(req, "list_callrail_calls", async ({ apiKey }) => {
      const response = await listCallRailCalls({ ...parsed, apiKey });
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_callrail_call", {
    title: "Get CallRail Call",
    description: "Get one CallRail call record, including transcript, recording, landing page, tags, source, and attribution fields when available from the API.",
    inputSchema: {
      accountId: z.string().min(1),
      callId: z.string().min(1),
      query: z.record(z.any()).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      callId: z.string().min(1),
      query: z.record(z.any()).optional()
    }).parse(params);
    return withCallRailTool(req, "get_callrail_call", async ({ apiKey }) => {
      const response = await getCallRailCall({ ...parsed, apiKey });
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_callrail_call_summary", {
    title: "Get CallRail Call Summary",
    description: "Get CallRail aggregated call summary metrics for an account using CallRail summary filters.",
    inputSchema: {
      accountId: z.string().min(1),
      query: z.record(z.any()).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      query: z.record(z.any()).optional()
    }).parse(params);
    return withCallRailTool(req, "get_callrail_call_summary", async ({ apiKey }) => {
      const response = await getCallRailCallSummary({ ...parsed, apiKey });
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_callrail_call_timeseries", {
    title: "Get CallRail Call Timeseries",
    description: "Get CallRail time-series call metrics for trend analysis with channels, campaigns, sources, and attribution filters.",
    inputSchema: {
      accountId: z.string().min(1),
      query: z.record(z.any()).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      query: z.record(z.any()).optional()
    }).parse(params);
    return withCallRailTool(req, "get_callrail_call_timeseries", async ({ apiKey }) => {
      const response = await getCallRailCallTimeseries({ ...parsed, apiKey });
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("list_callrail_trackers", {
    title: "List CallRail Trackers",
    description: "List CallRail tracking numbers and trackers for an account.",
    inputSchema: {
      accountId: z.string().min(1),
      query: z.record(z.any()).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      accountId: z.string().min(1),
      query: z.record(z.any()).optional()
    }).parse(params);
    return withCallRailTool(req, "list_callrail_trackers", async ({ apiKey }) => {
      const response = await listCallRailTrackers({ ...parsed, apiKey });
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  server.registerTool("get_callrail_connection", {
    title: "Get CallRail Connection",
    description: "Show which CallRail account this session is connected to, whether the key came from the session or a shared server key, and how many accounts it can reach. The API key itself is never returned, only a masked fingerprint.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => withCallRailTool(req, "get_callrail_connection", async ({ apiKey, credentials }) => {
    const response = await listCallRailAccounts({ apiKey });
    const accounts = response.ok ? (response.body?.accounts || []) : [];
    return buildToolResult({
      connected: response.ok,
      // A fingerprint is enough to tell two keys apart without exposing either.
      keyFingerprint: maskCallRailKey(apiKey),
      keySource: credentials.source === "shared_environment"
        ? "shared_environment"
        : "session",
      sharedKeyWarning: credentials.source === "shared_environment"
        ? "This server is using its own CALLRAIL_API_TOKEN, so every user of this deployment shares one CallRail account. Connect a personal key at /auth/callrail."
        : undefined,
      connectedAt: credentials.connectedAt || null,
      accountCount: accounts.length,
      accounts: accounts.map((account) => ({ id: account.id, name: account.name })),
      guardrails: PLATFORM_GUARDRAILS.callrail,
      raw: response.ok ? { accountCount: accounts.length } : toGoogleDebugPayload(response)
    }, !response.ok);
  }));
  server.registerTool("list_meta_ad_accounts", {
    title: "List Meta Ad Accounts",
    description: "List the Meta ad accounts the authorized user can access, with id, name, currency, timezone and account status.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional(),
      after: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      limit: z.number().int().min(1).max(500).optional(),
      after: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_meta_ad_accounts, async ({ metaCredentials }) => {
      const response = await callMetaGraphApi("me/adaccounts", metaCredentials.accessToken, {
        fields: "id,account_id,name,currency,timezone_name,account_status,business_name",
        limit: parsed.limit || 100,
        after: parsed.after
      });
      return buildToolResult({
        graphApiVersion: getMetaGraphApiVersion(),
        guardrails: PLATFORM_GUARDRAILS.meta,
        nextCursor: response.body?.paging?.cursors?.after || null,
        raw: toMetaDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("list_meta_pages", {
    title: "List Meta Pages",
    description: "List the Facebook Pages the authorized user manages, with id, name, category and any linked Instagram business account. Page access tokens are deliberately not returned; they are resolved internally when a Page or Instagram preset needs one.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional(),
      after: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      limit: z.number().int().min(1).max(500).optional(),
      after: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_meta_pages, async ({ metaCredentials }) => {
      const response = await callMetaGraphApi("me/accounts", metaCredentials.accessToken, {
        fields: "id,name,category,tasks,instagram_business_account{id,username}",
        limit: parsed.limit || 100,
        after: parsed.after
      });
      // Strip page access tokens so credentials never reach the model or the transcript.
      const pages = (response.body?.data || []).map((page) => ({
        id: page.id,
        name: page.name,
        category: page.category,
        tasks: page.tasks,
        instagramBusinessAccountId: page.instagram_business_account?.id || null,
        instagramUsername: page.instagram_business_account?.username || null
      }));
      return buildToolResult({
        graphApiVersion: getMetaGraphApiVersion(),
        pageCount: pages.length,
        pages,
        nextCursor: response.body?.paging?.cursors?.after || null,
        guardrails: PLATFORM_GUARDRAILS.meta,
        raw: response.ok ? { paging: response.body?.paging || null } : toMetaDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("list_meta_instagram_accounts", {
    title: "List Meta Instagram Accounts",
    description: "List Instagram business accounts reachable through the authorized user's Pages, with follower and media counts. Each Instagram account is returned alongside the Page it is linked to, which is the pageId to pass to Instagram presets.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({ limit: z.number().int().min(1).max(500).optional() }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.list_meta_instagram_accounts, async ({ metaCredentials }) => {
      const response = await callMetaGraphApi("me/accounts", metaCredentials.accessToken, {
        fields: "id,name,instagram_business_account{id,username,name,followers_count,media_count,profile_picture_url}",
        limit: parsed.limit || 100
      });
      const accounts = (response.body?.data || [])
        .filter((page) => page.instagram_business_account)
        .map((page) => ({
          instagramAccountId: page.instagram_business_account.id,
          username: page.instagram_business_account.username,
          name: page.instagram_business_account.name,
          followersCount: toNumber(page.instagram_business_account.followers_count),
          mediaCount: toNumber(page.instagram_business_account.media_count),
          pageId: page.id,
          pageName: page.name
        }));
      return buildToolResult({
        graphApiVersion: getMetaGraphApiVersion(),
        accountCount: accounts.length,
        accounts,
        guardrails: PLATFORM_GUARDRAILS.meta,
        raw: response.ok ? { paging: response.body?.paging || null } : toMetaDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("get_meta_token_info", {
    title: "Get Meta Token Info",
    description: "Inspect the stored Meta access token: which permissions were actually granted, which Meta user it belongs to, and when it expires. Meta has no refresh tokens, so use this to check how long the connection has left before re-authorization is needed.",
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => withVerifiedToolAuth(req, TOOL_SCOPE_MAP.get_meta_token_info, async ({ metaCredentials }) => {
    const debug = await debugMetaToken(metaCredentials.accessToken);
    const data = debug.body?.data || {};
    const expiresAtMs = data.expires_at ? Number(data.expires_at) * 1000 : metaCredentials.expiresAt;
    return buildToolResult({
      graphApiVersion: getMetaGraphApiVersion(),
      userId: data.user_id || metaCredentials.userId || null,
      appId: data.app_id || null,
      isValid: data.is_valid ?? null,
      grantedScopes: data.scopes || normalizeMetaScopes(metaCredentials.scope),
      expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
      daysUntilExpiry: expiresAtMs ? Math.max(0, Math.round((expiresAtMs - Date.now()) / 86400000)) : null,
      neverExpires: !expiresAtMs,
      guardrails: PLATFORM_GUARDRAILS.meta,
      raw: debug.ok ? debug.body : { status: debug.status, error: debug.body }
    }, !debug.ok);
  }));
  server.registerTool("query_meta_graph", {
    title: "Query Meta Graph API",
    description: "Run an arbitrary read-only Meta Graph API GET request for anything the presets do not cover. Supply a node path such as act_123/insights or 17841400000000000/media, plus query parameters. Access tokens are injected by the server and must never be passed here.",
    inputSchema: {
      path: z.string().min(1),
      params: z.record(z.any()).optional(),
      pageId: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      path: z.string().min(1),
      params: z.record(z.any()).optional(),
      pageId: z.string().optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.query_meta_graph, async ({ metaCredentials }) => {
      const cleanPath = String(parsed.path).replace(/^\/+/, "");
      if (/^https?:/i.test(cleanPath)) {
        return buildToolResult({
          error: "invalid_meta_path",
          error_description: "Pass a Graph node path such as act_123/insights, not a full URL."
        }, true);
      }
      const supplied = { ...(parsed.params || {}) };
      // Refuse caller-supplied credentials rather than silently honouring them.
      for (const key of ["access_token", "appsecret_proof", "client_secret"]) {
        if (key in supplied) {
          return buildToolResult({
            error: "credentials_not_accepted",
            error_description: `Remove ${key}. The server injects Meta credentials itself.`
          }, true);
        }
      }
      let token = metaCredentials.accessToken;
      let requestCount = 1;
      if (parsed.pageId) {
        const pageToken = await resolveMetaPageAccessToken(metaCredentials.accessToken, parsed.pageId);
        requestCount += 1;
        if (pageToken) token = pageToken;
      }
      const response = await callMetaGraphApi(cleanPath, token, supplied);
      return buildToolResult({
        path: cleanPath,
        graphApiVersion: getMetaGraphApiVersion(),
        usedPageToken: Boolean(parsed.pageId),
        requestCount,
        guardrails: PLATFORM_GUARDRAILS.meta,
        raw: toMetaDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("run_meta_preset", {
    title: "Run Meta Preset",
    description: "Run expert Meta reports across three surfaces. Meta Ads: account, campaign, ad set and ad performance, daily trends, age and gender, country, region, platform, device, placement, video and conversions. Facebook Page organic: overview, daily trends, audience growth and per-post performance. Instagram organic: account overview, daily trends, media performance, stories and follower demographics. All results are normalized into the cross-platform schema so Meta joins Google Ads, GA4, Search Console and CallRail.",
    inputSchema: {
      preset: z.enum(META_PRESET_NAMES),
      adAccountId: z.string().optional(),
      pageId: z.string().optional(),
      instagramAccountId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      after: z.string().optional(),
      includeDailyBreakdown: z.boolean().optional(),
      breakdowns: z.string().optional(),
      actionBreakdowns: z.string().optional(),
      conversionActionType: z.string().optional(),
      metrics: z.string().optional(),
      fields: z.string().optional(),
      period: z.enum(["day", "week", "days_28", "lifetime"]).optional(),
      filtering: z.array(z.record(z.any())).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      preset: z.enum(META_PRESET_NAMES),
      adAccountId: z.string().optional(),
      pageId: z.string().optional(),
      instagramAccountId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      after: z.string().optional(),
      includeDailyBreakdown: z.boolean().optional(),
      breakdowns: z.string().optional(),
      actionBreakdowns: z.string().optional(),
      conversionActionType: z.string().optional(),
      metrics: z.string().optional(),
      fields: z.string().optional(),
      period: z.enum(["day", "week", "days_28", "lifetime"]).optional(),
      filtering: z.array(z.record(z.any())).optional()
    }).parse(params);
    return withVerifiedToolAuth(req, TOOL_SCOPE_MAP.run_meta_preset, async ({ metaCredentials, scopes }) => {
      let presetConfig;
      try {
        presetConfig = buildMetaPresetRequest(parsed);
      } catch (error) {
        return buildToolResult({
          error: "invalid_meta_preset_request",
          error_description: error instanceof Error ? error.message : String(error),
          preset: parsed.preset,
          presetCatalog: META_PRESET_DEFINITIONS[parsed.preset] || null
        }, true);
      }

      // Surface the missing-permission case as a clear message instead of a raw Meta error.
      const requiredScopeBySurface = {
        ads: [META_ADS_SCOPE],
        page: [META_PAGES_READ_SCOPE, META_INSIGHTS_SCOPE],
        instagram: [META_INSTAGRAM_SCOPE, META_INSTAGRAM_INSIGHTS_SCOPE]
      }[presetConfig.surface] || [];
      const missingScopes = requiredScopeBySurface.filter((scope) => !scopes.includes(scope));
      if (missingScopes.length) {
        return buildToolResult({
          error: "insufficient_meta_permissions",
          error_description: `This session was not granted ${missingScopes.join(", ")}. Re-authorize at /auth/meta/start, and note these permissions need Meta App Review before non-testers can grant them.`,
          preset: parsed.preset,
          surface: presetConfig.surface,
          grantedScopes: scopes.filter((scope) => META_SCOPES.includes(scope))
        }, true);
      }

      const notes = [...presetConfig.notes];
      let token = metaCredentials.accessToken;
      let requestCount = 1;
      if (presetConfig.needsPageToken && parsed.pageId) {
        const pageToken = await resolveMetaPageAccessToken(metaCredentials.accessToken, parsed.pageId);
        requestCount += 1;
        if (pageToken) {
          token = pageToken;
        } else {
          notes.push("Could not resolve a Page access token for this pageId; falling back to the user token. If Meta rejects the call, confirm the user manages this Page.");
        }
      }

      const response = await callMetaGraphApi(presetConfig.path, token, presetConfig.query);
      const normalizedRows = response.ok
        ? normalizeMetaPresetRows(parsed.preset, response.body, { conversionActionType: parsed.conversionActionType })
        : [];
      if (response.ok && !normalizedRows.length) {
        notes.push("Meta returned no rows. Common causes: no delivery in the window, an Instagram account under 100 followers for demographics, or a metric Meta has deprecated in this Graph version.");
      }

      return buildToolResult({
        preset: parsed.preset,
        surface: presetConfig.surface,
        entityType: presetConfig.entityType,
        dateRange: presetConfig.dateRange,
        graphApiVersion: getMetaGraphApiVersion(),
        usedPageToken: presetConfig.needsPageToken && requestCount > 1,
        requestCount,
        rowCount: normalizedRows.length,
        nextCursor: response.body?.paging?.cursors?.after || null,
        notes,
        request: { path: presetConfig.path, query: presetConfig.query },
        guardrails: PLATFORM_GUARDRAILS.meta,
        normalizedSchema: NORMALIZED_MARKETING_SCHEMA,
        normalizedRows,
        raw: toMetaDebugPayload(response)
      }, !response.ok);
    });
  });
  server.registerTool("run_callrail_preset", {
    title: "Run CallRail Preset",
    description: "Run expert CallRail reports. CallRail returns raw call records rather than aggregated reports, so this tool fetches one page of calls and aggregates them into call, answered, missed, qualified, first-time, duration, and lead-value totals grouped by source, medium, campaign, keyword, landing page, referrer, tracking number, company, device, city, lead status, tag, answered state, first-time state, duration bucket, or day. Results are normalized into the cross-platform schema so calls can be joined to Google Ads, GA4, and Search Console rows.",
    inputSchema: {
      preset: z.enum(CALLRAIL_PRESET_NAMES),
      accountId: z.string().min(1),
      companyId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      perPage: z.number().int().min(1).max(250).optional(),
      page: z.number().int().min(1).optional(),
      answeredOnly: z.boolean().optional(),
      minDurationSeconds: z.number().int().min(0).optional(),
      query: z.record(z.any()).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      preset: z.enum(CALLRAIL_PRESET_NAMES),
      accountId: z.string().min(1),
      companyId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      perPage: z.number().int().min(1).max(250).optional(),
      page: z.number().int().min(1).optional(),
      answeredOnly: z.boolean().optional(),
      minDurationSeconds: z.number().int().min(0).optional(),
      query: z.record(z.any()).optional()
    }).parse(params);
    return withCallRailTool(req, "run_callrail_preset", async ({ apiKey }) => {
      const definition = CALLRAIL_PRESET_DEFINITIONS[parsed.preset];
      if (!definition) {
        return buildToolResult({
          error: "invalid_callrail_preset",
          error_description: `Unsupported CallRail preset: ${parsed.preset}`,
          availablePresets: CALLRAIL_PRESET_NAMES
        }, true);
      }
      const dateRange = resolveDateWindow(parsed);
      const perPage = parsed.perPage || 250;
      const response = await listCallRailCalls({
        apiKey,
        accountId: parsed.accountId,
        query: {
          start_date: dateRange.startDate,
          end_date: dateRange.endDate,
          fields: CALLRAIL_PRESET_FIELDS,
          per_page: perPage,
          page: parsed.page || 1,
          ...(parsed.companyId ? { company_id: parsed.companyId } : {}),
          ...(parsed.query || {})
        }
      });
      if (!response.ok) {
        return buildToolResult({
          preset: parsed.preset,
          dateRange,
          guardrails: PLATFORM_GUARDRAILS.callrail,
          raw: { status: response.status, error: response.body }
        }, true);
      }
      const allCalls = Array.isArray(response.body?.calls) ? response.body.calls : [];
      const calls = allCalls.filter((call) => {
        if (parsed.answeredOnly && !call.answered) return false;
        if (parsed.minDurationSeconds !== undefined && (toNumber(call.duration) || 0) < parsed.minDurationSeconds) return false;
        return true;
      });
      const totalRecords = toNumber(response.body?.total_records);
      const fetched = allCalls.length;
      const notes = [];
      if (totalRecords !== undefined && totalRecords > fetched) {
        notes.push(`CallRail reports ${totalRecords} calls in this window but one page returned ${fetched}. Aggregates cover only this page; increase perPage or advance page to cover the rest.`);
      }
      if (calls.length !== fetched) {
        notes.push(`${fetched - calls.length} call(s) were excluded by answeredOnly / minDurationSeconds before aggregation.`);
      }
      if (parsed.preset === "calls_by_tag") {
        notes.push("Calls carrying multiple tags are counted once per tag, so tag totals can exceed the call total.");
      }
      const isDetail = parsed.preset === "call_details";
      const aggregated = isDetail ? [] : aggregateCallRailCalls(calls, parsed.preset);
      return buildToolResult({
        preset: parsed.preset,
        entityType: definition.entityType,
        groupBy: definition.groupBy || "none",
        dateRange,
        callsFetched: fetched,
        callsAggregated: calls.length,
        totalRecords: totalRecords ?? null,
        page: parsed.page || 1,
        perPage,
        hasMore: totalRecords !== undefined ? (parsed.page || 1) * perPage < totalRecords : null,
        notes,
        guardrails: PLATFORM_GUARDRAILS.callrail,
        normalizedSchema: NORMALIZED_MARKETING_SCHEMA,
        rows: isDetail ? calls : aggregated,
        normalizedRows: isDetail
          ? normalizeCallRailCallRecords(calls)
          : normalizeCallRailPresetRows(parsed.preset, aggregated)
      });
    });
  });
  server.registerTool("get_callrail_resource", {
    title: "Get CallRail Resource",
    description: "Fetch any supported read-only CallRail v3 JSON endpoint by path, for example /a/{accountId}/calls.json or /a/{accountId}/trackers.json.",
    inputSchema: {
      path: z.string().min(1),
      query: z.record(z.any()).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (params) => {
    const parsed = z.object({
      path: z.string().min(1),
      query: z.record(z.any()).optional()
    }).parse(params);
    return withCallRailTool(req, "get_callrail_resource", async ({ apiKey }) => {
      const response = await getCallRailResource({ ...parsed, apiKey });
      return buildToolResult(toGoogleDebugPayload(response), !response.ok);
    });
  });
  return server;
}

// Unlike Meta, CallRail needs nothing configured server-side, so the step is offered
// by default. Turn it off for deployments that deliberately share one key.
function shouldOfferCallRail() {
  return !["0", "false", "no"].includes(String(process.env.CALLRAIL_OFFER_STEP || "true").toLowerCase());
}

function buildCallRailStepUrl(req, parts) {
  const url = new URL(`${getBaseUrl(req)}/auth/callrail`);
  url.searchParams.set("chain", buildCallRailChainState(parts));
  return url.toString();
}

function buildCallRailChainState(parts) {
  return encryptJson({
    typ: "callrail_chain_state",
    sessionId: parts.sessionId,
    google: parts.google || null,
    meta: parts.meta || null,
    scope: parts.scope || "",
    resource: parts.resource,
    clientRedirectUri: parts.clientRedirectUri || null,
    clientState: parts.clientState || null,
    codeChallenge: parts.codeChallenge || null,
    codeChallengeMethod: parts.codeChallengeMethod || "S256",
    returnTo: parts.returnTo || "/",
    issuedAt: Date.now()
  });
}

function readCallRailChainState(value) {
  const chain = decryptJson(String(value));
  if (chain.typ !== "callrail_chain_state") throw new Error("wrong chain type");
  if (Date.now() - Number(chain.issuedAt || 0) > OAUTH_STATE_TTL_MS) {
    throw new Error("This page expired. Start again from /auth/google/start.");
  }
  return chain;
}

// Mints the final authorization code and sends the browser wherever it was headed.
function finishCallRailChain(req, res, chain, callRailCredentials) {
  const scope = buildSessionScope({
    googleScope: chain.google?.scope,
    metaScope: chain.meta?.scope,
    hasCallRail: Boolean(callRailCredentials?.apiKey),
    fallbackScope: chain.scope
  });

  saveSession(chain.sessionId, {
    sessionId: chain.sessionId,
    refreshToken: chain.google?.refreshToken || null,
    accessToken: null,
    expiryDate: 0,
    scope,
    tokenType: "Bearer",
    meta: chain.meta || null,
    callrail: callRailCredentials || null,
    sessionExpiresAt: Date.now() + SESSION_TTL_MS
  });

  const authCode = encryptJson({
    typ: "mcp_authorization_code",
    iss: getBaseUrl(req),
    aud: chain.resource,
    resource: chain.resource,
    sessionId: chain.sessionId,
    scope,
    codeChallenge: chain.codeChallenge,
    codeChallengeMethod: chain.codeChallengeMethod,
    exp: Date.now() + AUTH_CODE_TTL_MS,
    google: chain.google || undefined,
    meta: chain.meta || undefined,
    callrail: callRailCredentials || undefined
  });

  const connected = Boolean(callRailCredentials?.apiKey);
  const googleConnected = Boolean(chain.google?.refreshToken);
  const metaConnected = Boolean(chain.meta?.accessToken);

  let target;
  if (chain.clientRedirectUri) {
    const redirectUrl = new URL(String(chain.clientRedirectUri));
    redirectUrl.searchParams.set("code", authCode);
    if (chain.clientState) redirectUrl.searchParams.set("state", String(chain.clientState));
    target = redirectUrl.toString();
  } else {
    const successUrl = new URL(String(chain.returnTo || "/"), getBaseUrl(req));
    successUrl.searchParams.set("auth", "success");
    target = successUrl.toString();
  }

  return sendAuthStatusPage(res, {
    title: "You're all set",
    heading: "You're all set",
    message: connected
      ? "CallRail is connected with your own API key. Calls, trackers and attribution are ready to query alongside everything else."
      : "Your connection is ready. CallRail was skipped, so its tools stay switched off.",
    google: googleConnected ? "connected" : "pending",
    meta: metaConnected ? "connected" : "optional",
    callrail: connected ? "connected" : "optional",
    redirectUrl: target,
    redirectDelayMs: 2000,
    continueLabel: chain.clientRedirectUri ? "Finish setup" : "Done",
    tone: "success",
    footnote: connected
      ? "Your key is sealed into your own session. Nobody else using this server can see or use it."
      : `You can connect CallRail any time at ${getBaseUrl(req)}/auth/callrail.`
  });
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    name: "marketing-data-mcp",
    expertVersion: EXPERT_VERSION,
    mcpUrl: `${baseUrl}/mcp`,
    oauthStartUrl: `${baseUrl}/auth/google/start`,
    oauthCallbackUrl: `${baseUrl}/auth/google/callback`,
    metaAuthStartUrl: `${baseUrl}/auth/meta/start`,
    metaLoginMode: process.env.META_LOGIN_CONFIG_ID ? "business_config" : "scope",
    metaOauthCallbackUrl: `${baseUrl}/auth/meta/callback`,
    // Google is the only provider required to connect. Meta is an add-on.
    requiredProviders: ["google"],
    optionalProviders: isMetaConfigured() ? ["meta"] : [],
    metaOfferedAfterGoogle: shouldOfferMetaAfterGoogle(),
    tokenUrl: `${baseUrl}/oauth/token`,
    resource: getResourceUrl(req),
    scopes: GOOGLE_SCOPES,
    tools: [...Object.keys(TOOL_SCOPE_MAP), ...CALLRAIL_TOOL_NAMES, ...EXPERT_TOOL_NAMES],
    presets: buildMarketingPresetCatalog()
  });
});

app.get("/debug/integrations", async (req, res) => {
  try {
    const payload = await buildIntegrationDebugPayload(req);
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      error: "integration_debug_failed",
      error_description: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/auth/google/start", (req, res) => {
  try {
    logAuthRouteDebug({
      route: "/auth/google/start",
      env_present: {
        GOOGLE_CLIENT_ID: Boolean(process.env.GOOGLE_CLIENT_ID),
        GOOGLE_CLIENT_SECRET: Boolean(process.env.GOOGLE_CLIENT_SECRET),
        BASE_URL: Boolean(process.env.BASE_URL),
        APP_BASE_URL: Boolean(process.env.APP_BASE_URL),
        SESSION_SECRET: Boolean(process.env.SESSION_SECRET),
        APP_ENCRYPTION_KEY: Boolean(process.env.APP_ENCRYPTION_KEY),
        GOOGLE_ADS_DEVELOPER_TOKEN: Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
        GOOGLE_ADS_LOGIN_CUSTOMER_ID: Boolean(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
    GOOGLE_ADS_ACCESS_LEVEL: String(process.env.GOOGLE_ADS_ACCESS_LEVEL || "basic"),
    META_APP_ID: Boolean(process.env.META_APP_ID),
    META_APP_SECRET: Boolean(process.env.META_APP_SECRET),
    META_GRAPH_API_VERSION: String(process.env.META_GRAPH_API_VERSION || "v21.0"),
        META_LOGIN_CONFIG_ID: Boolean(process.env.META_LOGIN_CONFIG_ID),
        CALLRAIL_API_TOKEN: Boolean(process.env.CALLRAIL_API_TOKEN)
      }
    });

    const computedRedirectUri = `${getBaseUrl(req)}/auth/google/callback`;
    logAuthRouteDebug({
      route: "/auth/google/start",
      computed_redirect_uri: computedRedirectUri
    });

    const oauthClient = createOauthClient(req);
    const requestedScopes = normalizeGoogleAuthScopes(req.query.scope);
    const resource = getRequestedResource(req, getResourceUrl(req));
    const clientRedirectUri = resolveClientRedirectUri(req);
    const appState = {
      offerMeta: shouldOfferMetaAfterGoogle(req.query.include_meta),
      returnTo: req.query.return_to || "/",
      clientRedirectUri,
      clientState: req.query.state || null,
      codeChallenge: req.query.code_challenge || null,
      codeChallengeMethod: req.query.code_challenge_method || "S256",
      scope: requestedScopes.join(" "),
      resource,
      audience: resource,
      issuedAt: Date.now()
    };

    const googleAuthUrl = oauthClient.generateAuthUrl({
      access_type: "offline",
      scope: requestedScopes,
      include_granted_scopes: true,
      // select_account always shows the Google account chooser; consent is required
      // for Google to return a refresh token on repeat authorizations.
      prompt: "select_account consent",
      state: encryptJson(appState)
    });

    logAuthRouteDebug({
      route: "/auth/google/start",
      generated_auth_url: googleAuthUrl
    });

    return res.redirect(302, googleAuthUrl);
  } catch (error) {
    logAuthRouteDebug({
      route: "/auth/google/start",
      error_message: error instanceof Error ? error.message : String(error),
      error_stack: error instanceof Error ? error.stack : String(error)
    });

    return res.status(error?.statusCode || 500).json({
      error: error?.oauthError || "auth_start_failed",
      error_description: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).json({ error: "Missing Google OAuth code or state." });
    }

    const appState = decryptJson(state);
    if (Date.now() - Number(appState.issuedAt || 0) > OAUTH_STATE_TTL_MS) {
      return res.status(400).json({ error: "OAuth state expired. Start over from /auth/google/start." });
    }

    const oauthClient = createOauthClient(req);
    const { tokens } = await oauthClient.getToken(String(code));
    if (!tokens.refresh_token) {
      return res.status(400).json({
        error: "Google did not return a refresh token. Re-run consent with prompt=consent."
      });
    }

    // Check who this is before issuing anything. The Google Ads developer token and any
    // shared CallRail key are central resources handed to whoever connects, so the gate
    // belongs here rather than at the tools.
    const connectingEmail = readEmailFromIdToken(tokens.id_token);
    const access = isEmailAllowed(connectingEmail);
    if (!access.allowed) {
      logAuthRouteDebug({
        route: "/auth/google/callback",
        access_denied: true,
        reason: access.reason,
        domain: access.domain || null
      });
      return sendAuthStatusPage(res, {
        httpStatus: 403,
        title: "Access not available",
        heading: "This account can't connect",
        message: access.reason === "no_email"
          ? "Google did not return an email address for this account, so access could not be checked. Reconnect and allow the email permission."
          : "This server is limited to the team. Sign in again with your work account, or ask an admin to add your address.",
        google: "failed",
        meta: "pending",
        callrail: "hidden",
        autoAdvance: false,
        redirectUrl: `${getBaseUrl(req)}/auth/google/start`,
        continueLabel: "Try a different account",
        footnote: connectingEmail ? `Signed in as ${connectingEmail}` : ""
      });
    }

    const grantedScopes = normalizeGoogleAuthScopes(tokens.scope || appState.scope);
    const sessionId = crypto.randomUUID();
    saveSession(sessionId, {
      email: connectingEmail,
      sessionId,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiryDate: tokens.expiry_date,
      scope: tokens.scope || grantedScopes.join(" "),
      tokenType: tokens.token_type || "Bearer",
      sessionExpiresAt: Date.now() + SESSION_TTL_MS
    });

    const authCode = encryptJson({
      typ: "mcp_authorization_code",
      iss: getBaseUrl(req),
      aud: appState.resource,
      resource: appState.resource,
      sessionId,
      scope: grantedScopes.join(" "),
      codeChallenge: appState.codeChallenge,
      codeChallengeMethod: appState.codeChallengeMethod,
      exp: Date.now() + AUTH_CODE_TTL_MS,
      google: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date,
        scope: tokens.scope || grantedScopes.join(" "),
        tokenType: tokens.token_type || "Bearer"
      }
    });

    // Carries the finished Google authorization through the Meta flow, so that
    // completing Meta *or* failing it both still hand the connector a usable code.
    const buildMetaChainUrl = () => {
      const chainUrl = new URL(`${getBaseUrl(req)}/auth/meta/start`);
      chainUrl.searchParams.set("chain", encryptJson({
        typ: "meta_chain_state",
        sessionId,
        googleAuthCode: authCode,
        google: {
          email: connectingEmail,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          expiryDate: tokens.expiry_date,
          scope: tokens.scope || grantedScopes.join(" "),
          tokenType: tokens.token_type || "Bearer"
        },
        googleScope: grantedScopes.join(" "),
        clientRedirectUri: appState.clientRedirectUri || null,
        clientState: appState.clientState || null,
        codeChallenge: appState.codeChallenge || null,
        codeChallengeMethod: appState.codeChallengeMethod || "S256",
        resource: appState.resource,
        returnTo: appState.returnTo || "/",
        issuedAt: Date.now()
      }));
      return chainUrl.toString();
    };

    // Where "finish on Google alone" sends the browser: back to the connector with the
    // code if one is waiting, otherwise to the app's own success page.
    const buildGoogleOnlyUrl = () => {
      // CallRail is the last optional step, so "finish on Google" still passes through
      // it rather than ending the connection early.
      if (shouldOfferCallRail()) {
        return buildCallRailStepUrl(req, {
          sessionId,
          google: {
            email: connectingEmail,
            refreshToken: tokens.refresh_token,
            accessToken: tokens.access_token,
            expiryDate: tokens.expiry_date,
            scope: tokens.scope || grantedScopes.join(" "),
            tokenType: tokens.token_type || "Bearer"
          },
          meta: null,
          scope: grantedScopes.join(" "),
          resource: appState.resource,
          clientRedirectUri: appState.clientRedirectUri || null,
          clientState: appState.clientState || null,
          codeChallenge: appState.codeChallenge || null,
          codeChallengeMethod: appState.codeChallengeMethod || "S256",
          returnTo: appState.returnTo || "/"
        });
      }
      if (appState.clientRedirectUri) {
        const redirectUrl = new URL(String(appState.clientRedirectUri));
        redirectUrl.searchParams.set("code", authCode);
        if (appState.clientState) redirectUrl.searchParams.set("state", String(appState.clientState));
        return redirectUrl.toString();
      }
      const successUrl = new URL(String(appState.returnTo || "/"), getBaseUrl(req));
      successUrl.searchParams.set("auth", "success");
      successUrl.searchParams.set("provider", "google");
      return successUrl.toString();
    };

    // Google is done and the connection already works, so Meta is a genuine either/or:
    // ask once and let the answer decide. Nothing auto-advances. Both outcomes are valid,
    // and Facebook's failure screens are terminal pages whose only way back is the browser
    // back button, which would land here again on an already spent authorization code.
    if (appState.offerMeta && isMetaConfigured()) {
      logAuthRouteDebug({ route: "/auth/google/callback", offering_meta_choice: true });
      return sendAuthStatusPage(res, {
        title: "Add Meta?",
        heading: "Google is connected",
        message: "Ads, Analytics, Search Console and Merchant Center are ready to query. Add Facebook and Instagram too, or carry on with Google on its own.",
        google: "connected",
        meta: "optional",
        callrail: shouldOfferCallRail() ? "optional" : "hidden",
        autoAdvance: false,
        redirectUrl: buildMetaChainUrl(),
        continueLabel: "Connect Meta",
        secondaryUrl: buildGoogleOnlyUrl(),
        secondaryLabel: "Skip — continue with Google only",
        footnote: `Meta is optional and nothing here depends on it. You can add it later at ${getBaseUrl(req)}/auth/meta.`
      });
    }

    // The question was suppressed, so there is nothing to decide: finish on Google.
    return sendAuthStatusPage(res, {
      title: "Google connected",
      heading: "You're all set",
      message: "Ads, Analytics, Search Console and Merchant Center are ready to query.",
      google: "connected",
      meta: isMetaConfigured() ? "optional" : "pending",
      callrail: shouldOfferCallRail() ? "optional" : "hidden",
      redirectUrl: buildGoogleOnlyUrl(),
      redirectDelayMs: 1800,
      continueLabel: appState.clientRedirectUri ? "Finish setup" : "Done",
      tone: "success",
      footnote: isMetaConfigured()
        ? `Facebook and Instagram are optional. Add them any time at ${getBaseUrl(req)}/auth/meta.`
        : ""
    });
  } catch (error) {
    logAuthRouteDebug({
      route: "/auth/google/callback",
      error_message: error instanceof Error ? error.message : String(error),
      error_stack: error instanceof Error ? error.stack : String(error)
    });

    return res.status(500).json({
      error: "OAuth callback failed.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// /auth/meta is the documented entry point; /auth/meta/start is kept as an alias
// so links already handed out keep working.
app.get(["/auth/meta", "/auth/meta/start"], (req, res) => {
  try {
    logAuthRouteDebug({
      route: "/auth/meta/start",
      env_present: {
        META_APP_ID: Boolean(process.env.META_APP_ID),
        META_APP_SECRET: Boolean(process.env.META_APP_SECRET),
        META_GRAPH_API_VERSION: String(process.env.META_GRAPH_API_VERSION || "v21.0"),
        META_LOGIN_CONFIG_ID: Boolean(process.env.META_LOGIN_CONFIG_ID),
        BASE_URL: Boolean(process.env.BASE_URL),
        APP_BASE_URL: Boolean(process.env.APP_BASE_URL),
        APP_ENCRYPTION_KEY: Boolean(process.env.APP_ENCRYPTION_KEY)
      }
    });

    const redirectUri = getMetaRedirectUri(req);
    logAuthRouteDebug({ route: "/auth/meta/start", computed_redirect_uri: redirectUri });

    const requestedScopes = normalizeMetaScopes(req.query.scope);
    const configId = getMetaLoginConfigId(req.query.config_id);
    const resource = getRequestedResource(req, getResourceUrl(req));
    const clientRedirectUri = resolveClientRedirectUri(req);

    // link_token lets an existing Google-authorized MCP token be carried through this
    // flow, so a single connector ends up holding both Google and Meta credentials.
    let linkedGoogle = null;
    let linkedSessionId = null;
    let linkedScope = null;
    let chained = null;
    if (req.query.chain) {
      try {
        chained = decryptJson(String(req.query.chain));
        if (chained.typ !== "meta_chain_state") throw new Error("wrong chain type");
        if (Date.now() - Number(chained.issuedAt || 0) > OAUTH_STATE_TTL_MS) {
          throw new Error("chain state expired");
        }
        linkedGoogle = chained.google || null;
        linkedSessionId = chained.sessionId || null;
        linkedScope = chained.googleScope || null;
      } catch (error) {
        return res.status(400).json({
          error: "invalid_chain_state",
          error_description: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (req.query.link_token) {
      try {
        const linked = decryptJson(String(req.query.link_token));
        if (linked.typ === "mcp_access_token" || linked.typ === "mcp_refresh_token") {
          linkedGoogle = linked.google || null;
          linkedSessionId = linked.sessionId || null;
          linkedScope = linked.scope || null;
        }
      } catch {
        return res.status(400).json({
          error: "invalid_link_token",
          error_description: "link_token could not be decrypted. Pass an MCP access or refresh token issued by this server."
        });
      }
    }

    const appState = {
      provider: "meta",
      returnTo: chained?.returnTo || req.query.return_to || "/",
      clientRedirectUri: chained?.clientRedirectUri || clientRedirectUri,
      clientState: chained?.clientState ?? (req.query.state || null),
      codeChallenge: chained?.codeChallenge ?? (req.query.code_challenge || null),
      codeChallengeMethod: chained?.codeChallengeMethod || req.query.code_challenge_method || "S256",
      // Kept so a denied or failed Meta consent can still complete as Google-only.
      googleFallbackAuthCode: chained?.googleAuthCode || null,
      // Kept as a fallback for the callback when debug_token cannot be reached.
      scope: requestedScopes.join(" "),
      configId,
      loginMode: configId ? "business_config" : "scope",
      resource: chained?.resource || resource,
      audience: chained?.resource || resource,
      linkedGoogle,
      linkedSessionId,
      linkedScope,
      issuedAt: Date.now()
    };

    const authUrl = new URL(`https://www.facebook.com/${getMetaGraphApiVersion()}/dialog/oauth`);
    appendQueryParams(authUrl, {
      client_id: requireMetaAppId(),
      redirect_uri: redirectUri,
      response_type: "code",
      state: encryptJson(appState),
      // With a configuration, permissions and assets come from the config, so scope
      // is omitted. override_default_response_type is required for Login for Business
      // to honour response_type=code instead of returning a token in the fragment.
      ...(configId
        ? { config_id: configId, override_default_response_type: "true" }
        : { scope: requestedScopes.join(",") })
    });

    logAuthRouteDebug({ route: "/auth/meta/start", generated_auth_url: authUrl.toString() });
    return res.redirect(302, authUrl.toString());
  } catch (error) {
    logAuthRouteDebug({
      route: "/auth/meta/start",
      error_message: error instanceof Error ? error.message : String(error),
      error_stack: error instanceof Error ? error.stack : String(error)
    });
    return res.status(error?.statusCode || 500).json({
      error: error?.oauthError || "auth_start_failed",
      error_description: error instanceof Error ? error.message : String(error)
    });
  }
});

// When Meta consent fails inside a chained connector flow, the user has already
// completed Google consent. Finish the connection with Google alone rather than
// throwing that away and forcing them to start over.
function completeChainWithGoogleOnly(req, res, appState, reason) {
  if (!appState?.googleFallbackAuthCode) return false;
  logAuthRouteDebug({
    route: "/auth/meta/callback",
    meta_failed_falling_back_to_google_only: true,
    reason
  });
  const skipped = String(reason || "") === "meta_skipped_by_user";
  const partial = {
    title: skipped ? "Google connected" : "Meta didn't connect",
    heading: skipped ? "You're all set" : "Finished with Google only",
    message: skipped
      ? "Ads, Analytics, Search Console and Merchant Center are ready to query."
      : "Meta didn't finish connecting, so we kept your Google connection rather than making you start over. Everything except Facebook and Instagram works.",
    google: "connected",
    meta: skipped ? "optional" : "failed",
    redirectDelayMs: 3200,
    tone: skipped ? "success" : "progress",
    footnote: `Facebook and Instagram are optional. Add them any time at ${getBaseUrl(req)}/auth/meta.`
  };
  if (appState.clientRedirectUri) {
    const redirectUrl = new URL(String(appState.clientRedirectUri));
    redirectUrl.searchParams.set("code", String(appState.googleFallbackAuthCode));
    if (appState.clientState) redirectUrl.searchParams.set("state", String(appState.clientState));
    sendAuthStatusPage(res, { ...partial, redirectUrl: redirectUrl.toString(), continueLabel: "Finish setup" });
    return true;
  }
  const successUrl = new URL(String(appState.returnTo || "/"), getBaseUrl(req));
  successUrl.searchParams.set("auth", "success");
  successUrl.searchParams.set("provider", "google");
  successUrl.searchParams.set("meta_error", String(reason || "meta_authorization_failed"));
  sendAuthStatusPage(res, { ...partial, redirectUrl: successUrl.toString(), continueLabel: "Continue" });
  return true;
}

// Lets a user abandon the Meta step and still finish the connection. Facebook's own
// error screens ("App not active", "not a tester of this app") are terminal and never
// redirect back to /auth/meta/callback, so without this route someone who hits one has
// no way back to the Google authorization they already completed.
app.get("/auth/meta/skip", (req, res) => {
  let chained = null;
  try {
    chained = decryptJson(String(req.query.chain || ""));
    if (chained.typ !== "meta_chain_state") throw new Error("wrong chain type");
    if (Date.now() - Number(chained.issuedAt || 0) > OAUTH_STATE_TTL_MS) {
      throw new Error("chain state expired");
    }
  } catch (error) {
    return res.status(400).json({
      error: "invalid_chain_state",
      error_description: error instanceof Error ? error.message : String(error)
    });
  }

  const completed = completeChainWithGoogleOnly(
    req,
    res,
    {
      googleFallbackAuthCode: chained.googleAuthCode || null,
      clientRedirectUri: chained.clientRedirectUri || null,
      clientState: chained.clientState || null,
      returnTo: chained.returnTo || "/"
    },
    "meta_skipped_by_user"
  );
  if (completed) return undefined;

  return res.status(400).json({
    error: "nothing_to_skip",
    error_description: "This link carries no Google authorization to fall back to. Start again at /auth/google/start."
  });
});

app.get("/auth/meta/callback", async (req, res) => {
  try {
    // Meta reports user denial as error/error_description rather than an empty code.
    if (req.query.error) {
      let deniedState = null;
      try {
        deniedState = req.query.state ? decryptJson(String(req.query.state)) : null;
      } catch {
        // Unreadable state just means no fallback is possible.
      }
      if (completeChainWithGoogleOnly(req, res, deniedState, String(req.query.error))) return undefined;
      // Standalone /auth/meta run: there is no Google authorization to fall back to,
      // but this is still not a failure of the server. Meta is optional.
      logAuthRouteDebug({
        route: "/auth/meta/callback",
        meta_denied: String(req.query.error),
        meta_denied_description: String(req.query.error_description || req.query.error_reason || "")
      });
      return sendAuthStatusPage(res, {
        httpStatus: 200,
        title: "Meta not connected",
        heading: "Meta was not connected",
        message: String(
          req.query.error_description || req.query.error_reason || "Meta authorization was not completed."
        ),
        google: "pending",
        meta: "failed",
        footnote: "Meta is optional. Everything else in this server works without it.",
        secondaryUrl: `${getBaseUrl(req)}/auth/meta`,
        secondaryLabel: "Try Meta again"
      });
    }

    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).json({ error: "Missing Meta OAuth code or state." });
    }

    const appState = decryptJson(String(state));
    if (Date.now() - Number(appState.issuedAt || 0) > OAUTH_STATE_TTL_MS) {
      return res.status(400).json({ error: "OAuth state expired. Start over from /auth/meta/start." });
    }

    let shortLived;
    try {
      shortLived = await exchangeMetaCodeForToken(req, String(code));
    } catch (error) {
      if (completeChainWithGoogleOnly(req, res, appState, "meta_code_exchange_failed")) return undefined;
      throw error;
    }
    if (!shortLived?.access_token) {
      if (completeChainWithGoogleOnly(req, res, appState, "meta_no_access_token")) return undefined;
      return res.status(400).json({ error: "Meta did not return an access token." });
    }

    // Always trade up to a long-lived token; the short-lived one dies in about an hour.
    let tokenResponse = shortLived;
    try {
      const longLived = await exchangeMetaLongLivedToken(shortLived.access_token);
      if (longLived?.access_token) tokenResponse = longLived;
    } catch (error) {
      logAuthRouteDebug({
        route: "/auth/meta/callback",
        long_lived_exchange_failed: error instanceof Error ? error.message : String(error)
      });
    }

    // debug_token is authoritative about what was actually granted; the requested
    // scope list is not, because the user can untick permissions in the dialog.
    let grantedScopes = normalizeMetaScopes(appState.scope);
    let scopeSource = "requested_fallback";
    let metaUserId = null;
    try {
      const debug = await debugMetaToken(tokenResponse.access_token);
      const data = debug.body?.data;
      if (data?.scopes?.length) {
        grantedScopes = normalizeMetaScopes(data.scopes.join(" "));
        scopeSource = "debug_token";
      }
      if (data?.user_id) metaUserId = String(data.user_id);
    } catch (error) {
      logAuthRouteDebug({
        route: "/auth/meta/callback",
        debug_token_failed: error instanceof Error ? error.message : String(error)
      });
    }

    logAuthRouteDebug({
      route: "/auth/meta/callback",
      login_mode: appState.loginMode || "scope",
      scope_source: scopeSource,
      granted_scope_count: grantedScopes.length
    });

    const metaCredentials = buildMetaCredentials(tokenResponse, grantedScopes, metaUserId);
    const linkedGoogleScopes = appState.linkedGoogle ? normalizeGoogleAuthScopes(appState.linkedGoogle.scope || appState.linkedScope) : [];
    const combinedScope = Array.from(new Set([...linkedGoogleScopes, ...grantedScopes])).join(" ");

    const sessionId = appState.linkedSessionId || crypto.randomUUID();
    saveSession(sessionId, {
      sessionId,
      refreshToken: appState.linkedGoogle?.refreshToken || null,
      accessToken: null,
      expiryDate: 0,
      scope: combinedScope,
      tokenType: "Bearer",
      meta: metaCredentials,
      sessionExpiresAt: Date.now() + SESSION_TTL_MS
    });

    const authCode = encryptJson({
      typ: "mcp_authorization_code",
      iss: getBaseUrl(req),
      aud: appState.resource,
      resource: appState.resource,
      sessionId,
      scope: combinedScope,
      codeChallenge: appState.codeChallenge,
      codeChallengeMethod: appState.codeChallengeMethod,
      exp: Date.now() + AUTH_CODE_TTL_MS,
      google: appState.linkedGoogle || undefined,
      meta: metaCredentials,
      // CallRail is offered after Meta, so nothing is connected yet here; carry through
      // whatever an earlier step already collected.
      callrail: appState.linkedCallRail || undefined
    });

    // Meta is done; CallRail is the remaining optional step.
    if (shouldOfferCallRail()) {
      return res.redirect(302, buildCallRailStepUrl(req, {
        sessionId,
        google: appState.linkedGoogle || null,
        meta: metaCredentials,
        scope: combinedScope,
        resource: appState.resource,
        clientRedirectUri: appState.clientRedirectUri || null,
        clientState: appState.clientState || null,
        codeChallenge: appState.codeChallenge || null,
        codeChallengeMethod: appState.codeChallengeMethod || "S256",
        returnTo: appState.returnTo || "/"
      }));
    }

    const googleAlsoConnected = Boolean(appState.linkedGoogle?.refreshToken);
    const bothHeading = googleAlsoConnected ? "You're all set" : "Meta is connected";
    const bothMessage = googleAlsoConnected
      ? "Google and Meta are both connected. Ads, analytics, search, shopping, calls and social now answer in one place."
      : "Facebook and Instagram are ready to query.";

    if (appState.clientRedirectUri) {
      const redirectUrl = new URL(String(appState.clientRedirectUri));
      redirectUrl.searchParams.set("code", authCode);
      if (appState.clientState) redirectUrl.searchParams.set("state", String(appState.clientState));
      return sendAuthStatusPage(res, {
        title: bothHeading,
        heading: bothHeading,
        message: bothMessage,
        google: googleAlsoConnected ? "connected" : "pending",
        meta: "connected",
        redirectUrl: redirectUrl.toString(),
        redirectDelayMs: 2100,
        continueLabel: "Finish setup",
        tone: "success",
        footnote: "Meta access lasts about 60 days and renews each time you reconnect."
      });
    }

    const successUrl = new URL(String(appState.returnTo || "/"), getBaseUrl(req));
    successUrl.searchParams.set("auth", "success");
    successUrl.searchParams.set("provider", "meta");
    return sendAuthStatusPage(res, {
      title: bothHeading,
      heading: bothHeading,
      message: bothMessage,
      google: googleAlsoConnected ? "connected" : "pending",
      meta: "connected",
      redirectUrl: successUrl.toString(),
      redirectDelayMs: 2400,
      continueLabel: "Done",
      tone: "success",
      footnote: "Meta access lasts about 60 days and renews each time you reconnect."
    });
  } catch (error) {
    logAuthRouteDebug({
      route: "/auth/meta/callback",
      error_message: error instanceof Error ? error.message : String(error),
      error_stack: error instanceof Error ? error.stack : String(error)
    });
    return res.status(500).json({
      error: "OAuth callback failed.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Everything needed to finish a connection once CallRail has been answered. The
// authorization code is re-minted at the end because it has to carry whatever the
// user actually connected, which is not known until the last step.
app.get("/auth/callrail", (req, res) => {
  try {
    if (!req.query.chain) {
      // Reached directly rather than through a connection, so there is no session to
      // attach a key to. Say so instead of collecting a credential that goes nowhere.
      return sendAuthStatusPage(res, {
        title: "Connect CallRail",
        heading: "Start from your connector",
        message: "CallRail is connected as the last step of setting up this server, so that the key can be sealed into your session. Add the connector again and the CallRail screen will appear after Google.",
        google: "pending",
        meta: "optional",
        callrail: "optional",
        redirectUrl: `${getBaseUrl(req)}/auth/google/start`,
        autoAdvance: false,
        continueLabel: "Start connecting",
        footnote: "CallRail is optional. Everything else in this server works without it."
      });
    }
    const chain = readCallRailChainState(req.query.chain);
    return sendCallRailConnectPage(res, {
      chain: String(req.query.chain),
      skipUrl: `${getBaseUrl(req)}/auth/callrail/skip?chain=${encodeURIComponent(String(req.query.chain))}`,
      google: chain.google?.refreshToken ? "connected" : "pending",
      meta: chain.meta?.accessToken ? "connected" : "optional"
    });
  } catch (error) {
    return res.status(400).json({
      error: "invalid_chain_state",
      error_description: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/auth/callrail", async (req, res) => {
  let chain;
  try {
    chain = readCallRailChainState(req.body?.chain);
  } catch (error) {
    return res.status(400).json({
      error: "invalid_chain_state",
      error_description: error instanceof Error ? error.message : String(error)
    });
  }

  const apiKey = String(req.body?.apiKey || "").trim();
  const rerender = (message) => sendCallRailConnectPage(res, {
    chain: String(req.body?.chain || ""),
    skipUrl: `${getBaseUrl(req)}/auth/callrail/skip?chain=${encodeURIComponent(String(req.body?.chain || ""))}`,
    google: chain.google?.refreshToken ? "connected" : "pending",
    meta: chain.meta?.accessToken ? "connected" : "optional",
    errorMessage: message,
    httpStatus: 400
  });

  if (!apiKey) return rerender("Enter a CallRail API key, or skip this step.");

  let verification;
  try {
    verification = await verifyCallRailKey(apiKey);
  } catch (error) {
    // Never echo the failure verbatim: it can contain the key that was just sent.
    logAuthRouteDebug({ route: "/auth/callrail", verify_failed: true });
    return rerender("Could not reach CallRail to check that key. Try again in a moment.");
  }
  if (!verification.ok) return rerender(verification.message);

  logAuthRouteDebug({
    route: "/auth/callrail",
    connected: true,
    account_count: verification.accountCount
  });

  return finishCallRailChain(req, res, chain, {
    apiKey,
    accountId: verification.accountId,
    accountName: verification.accountName,
    connectedAt: new Date().toISOString()
  });
});

app.get("/auth/callrail/skip", (req, res) => {
  try {
    const chain = readCallRailChainState(req.query.chain);
    logAuthRouteDebug({ route: "/auth/callrail/skip", skipped: true });
    return finishCallRailChain(req, res, chain, null);
  } catch (error) {
    return res.status(400).json({
      error: "invalid_chain_state",
      error_description: error instanceof Error ? error.message : String(error)
    });
  }
});

// RFC 7009. Clients call this when a connector is removed. Tokens are self-contained so
// that any serverless instance can serve them, which means a token the client still
// holds keeps working; what this does is drop the stored session, so the CallRail key
// and Meta token held server-side stop existing. The real protection when someone
// removes a connector is that the client destroys the token, and the key lives nowhere
// else.
app.post("/oauth/revoke", (req, res) => {
  // The spec requires 200 for an invalid or already-revoked token, so nothing here
  // distinguishes a bad token from a good one.
  try {
    const token = req.body?.token;
    if (token) {
      const payload = decryptJson(String(token));
      if (payload?.sessionId) {
        const existed = Boolean(getSession(payload.sessionId));
        deleteSession(payload.sessionId);
        logAuthRouteDebug({
          route: "/oauth/revoke",
          session_found: existed,
          had_callrail: Boolean(payload.callrail?.apiKey),
          had_meta: Boolean(payload.meta?.accessToken)
        });
      }
    }
  } catch {
    // Undecryptable token: nothing to revoke, and the spec still wants a 200.
  }
  return res.status(200).end();
});

app.post("/oauth/token", async (req, res) => {
  try {
    const {
      grant_type: grantType,
      code,
      code_verifier: codeVerifier,
      refresh_token: refreshToken,
      resource,
      audience
    } = req.body;

    if (grantType === "authorization_code") {
      const payload = decryptJson(code);
      if (payload.typ !== "mcp_authorization_code") {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Code is not a Vercel-issued authorization code."
        });
      }
      if (!urlsMatch(payload.iss, getBaseUrl(req))) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Authorization code issuer mismatch."
        });
      }
      if (Date.now() > Number(payload.exp || 0)) {
        return res.status(400).json({ error: "expired_grant", error_description: "Code expired." });
      }
      if (payload.codeChallenge) {
        const verifierMethod = payload.codeChallengeMethod || "S256";
        const actualChallenge =
          verifierMethod === "S256" ? sha256Base64Url(String(codeVerifier || "")) : String(codeVerifier || "");
        if (actualChallenge !== payload.codeChallenge) {
          return res.status(400).json({
            error: "invalid_grant",
            error_description: "PKCE verification failed."
          });
        }
      }

      const requestedResource = String(resource || audience || payload.resource);
      if (!resourcesMatch(requestedResource, payload.resource)) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Requested resource does not match authorization code."
        });
      }

      const sessionId = payload.sessionId || crypto.randomUUID();
      const session = saveSession(sessionId, {
        sessionId,
        refreshToken: payload.google?.refreshToken || null,
        accessToken: payload.google?.accessToken || null,
        expiryDate: payload.google?.expiryDate || 0,
        scope: buildSessionScope({
          googleScope: payload.google?.scope,
          metaScope: payload.meta?.scope,
          hasCallRail: Boolean(session?.callrail?.apiKey || payload.callrail?.apiKey),
          fallbackScope: payload.scope
        }),
        tokenType: payload.google?.tokenType || "Bearer",
        meta: payload.meta?.accessToken ? payload.meta : null,
        callrail: payload.callrail?.apiKey ? payload.callrail : null,
        sessionExpiresAt: Date.now() + SESSION_TTL_MS
      });

      const accessToken = mintAccessToken(req, {
        sessionId,
        resource: payload.resource,
        scope: payload.scope,
        google: session.refreshToken ? session : null,
        meta: session.meta,
        callrail: session.callrail
      });
      const newRefreshToken = mintRefreshToken(req, {
        sessionId,
        resource: payload.resource,
        scope: payload.scope,
        google: session.refreshToken ? session : null,
        meta: session.meta,
        callrail: session.callrail
      });

      return res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: newRefreshToken,
        scope: payload.scope,
        resource: payload.resource
      });
    }

    if (grantType === "refresh_token") {
      let payload;
      try {
        payload = decryptJson(refreshToken);
      } catch {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Malformed refresh token."
        });
      }

      if (payload.typ !== "mcp_refresh_token") {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Refresh token is not a Vercel-issued refresh token."
        });
      }
      if (!urlsMatch(payload.iss, getBaseUrl(req))) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Refresh token issuer mismatch."
        });
      }
      if (Date.now() > Number(payload.exp || 0)) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Refresh token expired."
        });
      }

      const requestedResource = String(resource || audience || payload.resource);
      if (!resourcesMatch(requestedResource, payload.resource)) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Requested resource does not match refresh token."
        });
      }

      const sessionId = payload.sessionId || crypto.randomUUID();
      const existingSession = getSession(sessionId);
      const session = existingSession || saveSession(sessionId, {
        sessionId,
        refreshToken: payload.google?.refreshToken || null,
        accessToken: null,
        expiryDate: 0,
        scope: buildSessionScope({
          googleScope: payload.google?.scope,
          metaScope: payload.meta?.scope,
          hasCallRail: Boolean(session?.callrail?.apiKey || payload.callrail?.apiKey),
          fallbackScope: payload.scope
        }),
        tokenType: payload.google?.tokenType || "Bearer",
        meta: payload.meta?.accessToken ? payload.meta : null,
        callrail: payload.callrail?.apiKey ? payload.callrail : null,
        sessionExpiresAt: Date.now() + SESSION_TTL_MS
      });

      // The API key does not expire and needs no exchange, so it just rides along.
      const callRailCredentials = session.callrail || (payload.callrail?.apiKey ? payload.callrail : null);

      let googleCredentials = null;
      let refreshedScope = null;
      if (session.refreshToken) {
        try {
          const refreshed = await exchangeGoogleRefreshToken(req, session.refreshToken);
          refreshedScope = refreshed.scope;
          googleCredentials = saveSession(sessionId, {
            ...session,
            sessionId,
            accessToken: refreshed.access_token,
            refreshToken: session.refreshToken,
            expiryDate: refreshed.expiry_date,
            scope: refreshed.scope || session.scope || payload.scope,
            tokenType: refreshed.token_type || session.tokenType || "Bearer",
            sessionExpiresAt: Date.now() + SESSION_TTL_MS
          });
        } catch (error) {
          const permanent = isPermanentGoogleAuthFailure(error);
          console.log(JSON.stringify({
            type: "google_refresh_failed",
            grant: "refresh_token",
            permanent,
            message: error instanceof Error ? error.message : String(error)
          }));
          // Only a genuinely dead grant justifies sending the user back through
          // consent. A transient Google failure previously escaped as a 500, which
          // clients read as "this connection is broken" and answer by asking the
          // user to sign in again - so it is reported as retryable instead, with
          // the session and its refresh token left intact.
          if (permanent) {
            deleteSession(sessionId);
            return res.status(400).json({
              error: "invalid_grant",
              error_description: "Google access was revoked or expired. Reconnect at /auth/google/start."
            });
          }
          return res.status(503).json({
            error: "temporarily_unavailable",
            error_description: "Could not reach Google to refresh credentials. The connection is still valid; retry shortly."
          });
        }
      }

      // Meta has no refresh token, but re-exchanging a still-valid long-lived token
      // resets its 60-day window. Failure here must not break the Google refresh.
      let metaCredentials = (googleCredentials || session).meta || session.meta || null;
      if (metaCredentials?.accessToken) {
        try {
          const extended = await exchangeMetaLongLivedToken(metaCredentials.accessToken);
          if (extended?.access_token) {
            metaCredentials = buildMetaCredentials(extended, metaCredentials.scope, metaCredentials.userId);
          }
        } catch (error) {
          console.log(JSON.stringify({
            type: "meta_token_extend_failed",
            message: error instanceof Error ? error.message : String(error)
          }));
        }
      }

      // Google's refresh response only ever reports Google scopes, so re-merge the
      // Meta scopes rather than letting the refresh narrow the session.
      const grantedScopes = normalizeScopes(buildSessionScope({
        googleScope: refreshedScope || googleCredentials?.scope || payload.google?.scope,
        metaScope: metaCredentials?.scope || payload.meta?.scope,
        hasCallRail: Boolean(callRailCredentials?.apiKey || payload.callrail?.apiKey),
        fallbackScope: session.scope || payload.scope
      }));
      saveSession(sessionId, {
        ...(googleCredentials || session),
        sessionId,
        meta: metaCredentials,
        callrail: callRailCredentials,
        sessionExpiresAt: Date.now() + SESSION_TTL_MS
      });

      const accessToken = mintAccessToken(req, {
        sessionId,
        resource: payload.resource,
        scope: grantedScopes.join(" "),
        google: googleCredentials,
        meta: metaCredentials,
        callrail: callRailCredentials
      });
      const newRefreshToken = mintRefreshToken(req, {
        sessionId,
        resource: payload.resource,
        scope: grantedScopes.join(" "),
        google: googleCredentials,
        meta: metaCredentials,
        callrail: callRailCredentials
      });

      return res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: newRefreshToken,
        scope: grantedScopes.join(" "),
        resource: payload.resource
      });
    }

    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description: "Supported grant types are authorization_code and refresh_token."
    });
  } catch (error) {
    return res.status(500).json({
      error: "token_exchange_failed",
      error_description: error instanceof Error ? error.message : String(error)
    });
  }
});

function buildAuthorizationServerMetadata(req) {
  const baseUrl = getBaseUrl(req);
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/auth/google/start`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/register`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    scopes_supported: GOOGLE_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"]
  };
}

function buildProtectedResourceMetadata(req) {
  return {
    resource: getResourceUrl(req),
    authorization_servers: [getBaseUrl(req)],
    bearer_methods_supported: ["header"],
    scopes_supported: GOOGLE_SCOPES
  };
}

// RFC 7591 dynamic client registration. Claude and ChatGPT both require this to
// obtain a client_id before they can start the authorization flow. Registration is
// stateless: the sealed client_id carries the registered redirect URIs, which the
// authorization endpoint then enforces.
function handleClientRegistration(req, res) {
  try {
    return res.status(201).json(registerOauthClient(req, req.body || {}));
  } catch (error) {
    return res.status(400).json({
      error: "invalid_client_metadata",
      error_description: error instanceof Error ? error.message : String(error)
    });
  }
}

app.post("/register", handleClientRegistration);
app.post("/oauth/register", handleClientRegistration);

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json(buildAuthorizationServerMetadata(req));
});

app.get("/.well-known/oauth-authorization-server/mcp", (req, res) => {
  res.json(buildAuthorizationServerMetadata(req));
});

app.get("/.well-known/openid-configuration", (req, res) => {
  res.json(buildAuthorizationServerMetadata(req));
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json(buildProtectedResourceMetadata(req));
});

app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  res.json(buildProtectedResourceMetadata(req));
});

function sendUnauthorized(req, res, error) {
  // WWW-Authenticate is the signal that starts an OAuth flow, so it must only go out
  // when re-authorizing is genuinely the fix. A retryable upstream failure carries no
  // challenge and keeps its own status, otherwise every Google hiccup would read to
  // the client as "your login expired".
  const status = error?.statusCode || 401;
  if (status !== 401 && status !== 403) {
    return res.status(status).json(formatAuthErrorResponse(error || {}));
  }
  const parts = ['Bearer realm="mcp"', `resource_metadata="${getBaseUrl(req)}/.well-known/oauth-protected-resource"`];
  if (error?.oauthError) parts.push(`error="${error.oauthError}"`);
  if (error?.oauthErrorDescription) {
    parts.push(`error_description="${String(error.oauthErrorDescription).replace(/"/g, "'")}"`);
  }
  if (error?.details?.required_scopes?.length) parts.push(`scope="${error.details.required_scopes.join(" ")}"`);
  res.setHeader("WWW-Authenticate", parts.join(", "));
  return res.status(status).json(formatAuthErrorResponse(error || {}));
}

app.all("/mcp", async (req, res) => {
  // The MCP authorization spec expects a real 401 with WWW-Authenticate here so the
  // client can discover the authorization server and start the OAuth flow.
  try {
    await verifyMcpAccessToken(req, []);
  } catch (error) {
    // Every repeated sign-in prompt a user sees starts with one of these, so record
    // which check failed rather than leaving it to be inferred from the symptom.
    console.log(JSON.stringify({
      type: "mcp_auth_rejected",
      status: error?.statusCode || 401,
      reason: error?.details?.debug || error?.oauthError || "unknown",
      expected_issuer: error?.details?.expected_issuer,
      actual_issuer: error?.details?.actual_issuer,
      expected_resource: error?.details?.expected_resource,
      actual_resource: error?.details?.actual_resource,
      has_authorization_header: Boolean(req.get("authorization")),
      host: req.get("host")
    }));
    return sendUnauthorized(req, res, error);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createServer(req);

  try {
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    if (!res.headersSent) {
      res.status(statusCode).json({
        error: "mcp_request_failed",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  }
});

export default app;
