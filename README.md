# Marketing Data MCP Server for Vercel

This project is a Vercel-hosted Node.js MCP server for ChatGPT. The Vercel app is the OAuth authorization server for ChatGPT. Google-backed tools use one Google OAuth connection with product-specific scopes, and CallRail-backed tools use a server-side CallRail API token.

This server also includes an expert analyst layer:

- Debug visibility with `/debug/integrations`
- Preset workflows for PPC, SEO, and analytics tasks
- A normalized cross-platform marketing schema
- Guardrails so ChatGPT stays truthful about what each API can and cannot answer

It exposes these MCP tools:

- `list_search_console_sites`
- `query_search_console`
- `list_search_console_sitemaps`
- `get_search_console_sitemap`
- `inspect_search_console_url`
- `run_search_console_preset`
- `compare_search_console_periods`
- `list_ga4_properties`
- `run_ga4_report`
- `get_ga4_metadata`
- `check_ga4_compatibility`
- `batch_run_ga4_reports`
- `run_ga4_realtime_report`
- `run_ga4_pivot_report`
- `run_ga4_preset`
- `run_ga4_funnel_report`
- `run_ga4_cohort_report`
- `list_ga4_custom_definitions`
- `list_ga4_key_events`
- `list_ga4_data_streams`
- `list_merchant_accounts`
- `get_merchant_account`
- `list_merchant_products`
- `get_merchant_product`
- `search_merchant_reports`
- `list_merchant_subaccounts`
- `get_merchant_account_issues`
- `get_merchant_product_status_summary`
- `list_merchant_data_sources`
- `run_merchant_preset`
- `get_merchant_developer_registration`
- `register_merchant_developer`
- `list_google_ads_accessible_customers`
- `query_google_ads`
- `search_stream_google_ads`
- `get_google_ads_field`
- `search_google_ads_fields`
- `run_google_ads_preset`
- `list_google_ads_customer_clients`
- `list_callrail_accounts`
- `list_callrail_companies`
- `list_callrail_calls`
- `get_callrail_call`
- `get_callrail_call_summary`
- `get_callrail_call_timeseries`
- `list_callrail_trackers`
- `get_callrail_resource`
- `run_callrail_preset`
- `list_meta_ad_accounts`
- `list_meta_pages`
- `list_meta_instagram_accounts`
- `get_meta_token_info`
- `query_meta_graph`
- `run_meta_preset`
- `list_marketing_presets`
- `get_marketing_schema`
- `list_marketing_guardrails`
- `normalize_marketing_records`

## Routes

- `GET /mcp` and `POST /mcp` for the MCP endpoint. Requires a bearer token; unauthenticated
  requests get `401` with a `WWW-Authenticate` header pointing at the resource metadata, which
  is what makes MCP clients start the OAuth flow.
- `POST /register` (alias `POST /oauth/register`) for RFC 7591 dynamic client registration
- `GET /auth/google/start` as the app authorization endpoint that redirects into Google OAuth
- `GET /auth/google/callback` for the Google OAuth callback
- `POST /oauth/token` as the app token endpoint that mints Vercel-issued MCP tokens
- `GET /debug/integrations` for env, scope, auth, and tool readiness debugging
- `GET /.well-known/oauth-authorization-server` (also served at `/.well-known/openid-configuration`
  and `/.well-known/oauth-authorization-server/mcp`)
- `GET /.well-known/oauth-protected-resource` (also served at `/.well-known/oauth-protected-resource/mcp`)

## Connecting a client

Both Claude and ChatGPT discover the server automatically. Point them at `<APP_BASE_URL>/mcp`:

- **Claude Code**: `claude mcp add --transport http -s user ga4mcp <APP_BASE_URL>/mcp`, then
  `/mcp` -> Authenticate.
- **Claude Desktop / claude.ai**: Settings -> Connectors -> Add custom connector -> `<APP_BASE_URL>/mcp`.
- **ChatGPT**: add it as a custom connector using the same URL.

The client registers itself at `/register`, receives a `client_id`, and runs authorization code +
PKCE (S256). Google is asked with `prompt=select_account consent`, so the account chooser always
appears and Google always returns a refresh token.

Client redirect URIs are enforced: a `redirect_uri` is only accepted if it was registered under the
`client_id` presented, or if it is a loopback address (`localhost` / `127.0.0.1` / `[::1]`) for
native clients.

Issued MCP access tokens carry the Google refresh token sealed inside the encrypted token, so a
serverless cold start does not invalidate an existing connection. Sessions in memory are only a
warm cache; when a request lands on an instance that has never seen the session, it is rebuilt from
the token instead of forcing the user to sign in again.

## Required environment variables

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `APP_BASE_URL`
- `APP_ENCRYPTION_KEY`
- `GOOGLE_ADS_DEVELOPER_TOKEN` for Google Ads tools
- `CALLRAIL_API_TOKEN` for CallRail tools

Compatibility fallback names also supported:

- `BASE_URL`
- `SESSION_SECRET`

Optional:

- `CALLRAIL_API_BASE_URL` to override the default CallRail API base URL (`https://api.callrail.com/v3`)
- `GOOGLE_ADS_LOGIN_CUSTOMER_ID` for manager-account access in Google Ads
- `GOOGLE_ADS_API_VERSION` to override the default Google Ads API version (`v22`)
- `GOOGLE_ADS_ACCESS_LEVEL` to record the developer-token tier, `basic` (default) or `standard`
- `META_APP_ID` and `META_APP_SECRET` for the Meta (Facebook / Instagram) tools
- `META_GRAPH_API_VERSION` to pin the Graph API version (defaults to `v21.0`)
- `META_LOGIN_CONFIG_ID` to use a Facebook Login for Business configuration instead of a raw scope list (recommended)
- `CALLRAIL_ALLOW_SHARED_TOKEN` to let all users share one `CALLRAIL_API_TOKEN` (off by default; see CallRail notes)
- `CALLRAIL_OFFER_STEP` to drop the CallRail step from the connection flow

You can copy `.env.example` locally and fill in your values.

Generate `APP_ENCRYPTION_KEY` as a base64-encoded 32-byte secret. Example:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

## Google Cloud setup

1. Create a Google Cloud project.
2. Enable these APIs:
   - Google Search Console API
   - Google Analytics Data API
   - Google Analytics Admin API
   - Merchant API
   - Google Ads API
3. Create OAuth 2.0 credentials for a Web application.
4. Add this authorized redirect URI:

```text
https://YOUR-VERCEL-DOMAIN/auth/google/callback
```

## Scopes used

- `https://www.googleapis.com/auth/webmasters.readonly`
- `https://www.googleapis.com/auth/analytics.readonly`
- `https://www.googleapis.com/auth/content`
- `https://www.googleapis.com/auth/adwords`

## Coverage notes

- Google Ads access is both preset-driven and query-driven. `run_google_ads_preset` covers 34 expert reports end to end, while `query_google_ads` and `search_stream_google_ads` remain available for arbitrary GAQL when a report falls outside the catalogue.
- GA4 access is preset-driven, metadata-driven, and report-driven. `run_ga4_preset` covers 24 expert reports; `get_ga4_metadata` and `check_ga4_compatibility` let ChatGPT discover valid dimensions, metrics, attributes, and filter compatibility before running `run_ga4_report`, `run_ga4_realtime_report`, `run_ga4_pivot_report`, `run_ga4_funnel_report`, `run_ga4_cohort_report`, or `batch_run_ga4_reports`.
- Search Console supports Search Analytics via 14 presets plus period comparison, and Sites, Sitemaps, and URL Inspection. The aggregate Search Console UI Index Coverage report is not exposed as a matching public API; `inspect_search_console_url` is the URL-level API alternative.
- CallRail support is read-only and centered on calls, summaries, time series, trackers, and generic read-only JSON endpoints via `get_callrail_resource`. `run_callrail_preset` adds 18 aggregated reports that normalize into the cross-platform schema.
- Meta support covers three separate surfaces through one connector: Meta Ads (Marketing API insights), Facebook Page organic insights, and Instagram business insights. `query_meta_graph` is the raw escape hatch.
- The expert preset layer is designed for common analyst workflows, while the raw tools remain available for deeper custom work.

## Expert Layer

- `run_google_ads_preset` supports 34 presets:
  - Core performance: `campaign_performance`, `ad_group_performance`, `keyword_performance`, `search_terms`, `ad_performance`, `asset_performance`, `conversions_by_campaign`
  - Competitive and quality: `impression_share`, `quality_score`
  - Shopping and Performance Max: `shopping_performance`, `product_group_performance`, `pmax_asset_groups`, `pmax_search_terms`
  - Segmentation: `geo_performance`, `device_performance`, `ad_schedule_performance`, `demographics_age`, `demographics_gender`, `audience_performance`, `placement_performance`
  - Conversion and destination: `conversion_actions`, `landing_page_performance`, `expanded_landing_page_performance`
  - Account structure and settings: `account_overview`, `campaign_budgets`, `bidding_strategies`, `negative_keywords`, `shared_set_negative_keywords`
  - Media and calls: `video_performance`, `call_performance`
  - Audit and diagnostics: `change_history`, `recommendations`, `experiments`, `click_view`
  - Optional flags: `includeImpressionShare` (campaign, ad group, keyword presets) and `includeQualityScore` (keyword preset). Invalid combinations are rejected locally before any API request is spent.
- `run_ga4_preset` supports 24 presets:
  - Acquisition: `channels`, `traffic_acquisition`, `user_acquisition`, `source_medium`, `campaigns`, `google_ads_performance`
  - Content: `landing_pages`, `pages_and_screens`, `site_search`
  - Behaviour: `events`, `key_events`, `engagement_overview`, `daily_trends`, `attribution_breakdown`
  - Ecommerce: `ecommerce`, `item_performance`, `item_list_performance`, `promotions`, `ecommerce_funnel`
  - Audience: `demographics`, `demographics_detail`, `technology`, `new_vs_returning`, `audiences`
  - Options: `includeDailyBreakdown` adds a date dimension; `conversionMetric` switches between `keyEvents` (default) and the legacy `conversions`
- `run_search_console_preset` supports 14 presets:
  - Core: `queries`, `pages`, `query_page_pairs`, `striking_distance`
  - Segments: `countries`, `devices`, `country_device`, `search_appearance`, `branded_vs_non_branded`
  - Trends: `date_trends`, `date_query`, `date_page`
  - Surfaces: `discover_performance`, `news_performance`
- `run_merchant_preset` supports 13 presets:
  - Performance: `product_performance`, `brand_performance`, `category_performance`, `country_performance`, `non_product_performance`
  - Feed health: `product_status`
  - Pricing: `price_competitiveness`, `price_insights`
  - Market: `best_sellers`, `best_sellers_brands`, `competitive_visibility`, `competitive_visibility_benchmark`, `competitive_visibility_top_merchants`
- `run_callrail_preset` supports 18 presets:
  - Records: `call_details`, `calls_overview`
  - Attribution: `calls_by_source`, `calls_by_medium`, `calls_by_campaign`, `calls_by_keyword`, `calls_by_landing_page`, `calls_by_referrer`, `calls_by_tracker`
  - Segments: `calls_by_company`, `calls_by_device`, `calls_by_city`, `calls_by_lead_status`, `calls_by_tag`
  - Quality: `answered_vs_missed`, `first_time_vs_repeat`, `call_duration_buckets`
  - Trends: `daily_call_trends`
- `run_meta_preset` supports 22 presets across three surfaces:
  - Meta Ads: `ads_account_performance`, `ads_campaign_performance`, `ads_adset_performance`, `ads_ad_performance`, `ads_daily_trends`, `ads_conversions`, `ads_video_performance`
  - Meta Ads breakdowns: `ads_by_age_gender`, `ads_by_country`, `ads_by_region`, `ads_by_platform`, `ads_by_device`, `ads_by_placement`
  - Facebook Page organic: `page_overview`, `page_daily_trends`, `page_audience`, `page_posts`
  - Instagram organic: `instagram_account_overview`, `instagram_daily_trends`, `instagram_media_performance`, `instagram_stories`, `instagram_audience`
- Every preset returns:
  raw API output, generated request/query metadata, normalized cross-platform rows, and platform guardrails
- `get_marketing_schema` returns the normalized marketing record format and cross-source field mappings.
- `list_marketing_guardrails` returns platform truthfulness constraints.
- `normalize_marketing_records` lets ChatGPT map arbitrary fetched records into the normalized schema so results from Ads, GA4, GSC, Merchant, and CallRail can be compared in one answer.

## Merchant Center notes

- Merchant Center tools use the Google Merchant API v1.
- Merchant API rejects every call with `GCP_NOT_REGISTERED` until this server's Google Cloud project is registered against the Merchant Center account. Check with `get_merchant_developer_registration` and fix with `register_merchant_developer`, which must be run once per Merchant account and takes about 5 minutes to take effect.
- `register_merchant_developer` is the only write tool in this server. It grants the API_DEVELOPER role to the supplied email if that address is already a user on the account, and otherwise sends an invitation that has to be accepted, so prefer an email that already has access.
- Reports run against the GA `reports/v1` sub-API. Accounts, products and data sources use `accounts/v1`, `products/v1` and `datasources/v1`; product status aggregation uses `issueresolution/v1`.
- `run_merchant_preset` with `product_performance` and `marketingMethod: "ORGANIC"` reports free listing traffic, so it works without a Google Ads account.
- `product_status`, `price_competitiveness` and `price_insights` are current snapshots and ignore the date range. `best_sellers` needs `reportDate` plus `reportCountryCode`; `competitive_visibility` needs `reportCountryCode`.
- Set `includeItemIssues: false` on `product_status` if selecting the repeated `itemIssues` field is rejected for the account.
- Report queries use snake_case table and field names (`product_performance_view`, `offer_id`), while responses come back camelCase (`productPerformanceView`, `offerId`).
- `competitive_visibility` requires `reportCategoryId`, a numeric Google product category ID such as 536 for Home & Garden, and it is sent unquoted because the field is a number.
- `best_sellers` snaps `reportDate` to the Monday of that week for WEEKLY granularity, or to the first of the month for MONTHLY, because the API rejects any other date.
- Google may require the Cloud project to be registered for Merchant API access before Merchant Center requests succeed.
- The Merchant Center OAuth scope is not read-only; this server exposes only read-only Merchant Center MCP tools.
- `search_merchant_reports` is the reporting entry point for performance and diagnostic-style Merchant datasets that are available through the Merchant API.

## Google Ads notes

- Google Ads tools require both Google OAuth access and a valid `GOOGLE_ADS_DEVELOPER_TOKEN`.
- For MCC or manager-account setups, set `GOOGLE_ADS_LOGIN_CUSTOMER_ID` if Google Ads requires `login-customer-id` headers.
- `list_google_ads_accessible_customers` only returns accounts the OAuth user can reach directly. For a full manager-account tree use `list_google_ads_customer_clients`, which walks `customer_client` in a single request.
- Use `search_google_ads_fields` and `get_google_ads_field` first when you need to discover valid fields, segments, metrics, and filters before writing GAQL.

### Quota

- Set `GOOGLE_ADS_ACCESS_LEVEL` to `basic` or `standard` to document which developer-token tier this deployment holds. It defaults to `basic`.
- A Basic Access developer token is capped at roughly 15000 operations and 1000 requests per day across the whole token.
- Every tool call is exactly one Google Ads API request. Auto-pagination is deliberately not implemented so a single call can never silently drain the daily quota; page explicitly with the `nextPageToken` returned in each preset response.
- `limit` controls the GAQL `LIMIT`, while `pageSize` is clamped to the API maximum of 10000. Asking for more than 10000 rows returns the first page plus a `nextPageToken` and a note explaining the clamp.
- Prefer one wide preset over several narrow queries. The core performance presets already return cost, conversion, and value metrics together.

### Known API limits

- Auction Insights is not exposed by the Google Ads API. No tool in this server can return it, and none pretends to.
- Quality Score is a current attribute, not a historical series, so `quality_score` is a snapshot and ignores the date range.
- Conversion action segmentation is incompatible with cost, click, and impression metrics, so `conversion_actions` intentionally returns conversion metrics only.
- `change_history` is limited by Google to the last 30 days and 10000 rows; both are clamped automatically and reported in the response `notes`.
- `click_view` requires a single-day filter and only covers the last 90 days; the preset uses `endDate` as that day.
- `pmax_search_terms` requires `campaignId` because Google rejects `campaign_search_term_insight` without a campaign filter. Cost is not exposed for that resource.
- GAQL field paths are snake_case (`metrics.cost_micros`) while REST responses come back camelCase (`metrics.costMicros`); the normalizer resolves either spelling.

## GA4 notes

- Presets default to the `keyEvents` metric. GA4 renamed `conversions` to `keyEvents`; pass `conversionMetric: "conversions"` only if a property rejects the new name.
- `includeDailyBreakdown` is off by default so presets return totals for the window rather than one row per day.
- `google_ads_performance` needs a linked Google Ads account, and `site_search` needs site search configured on the property.
- `demographics_detail` needs Google signals; without it, age and gender come back as `(not set)`.
- GA4 applies thresholding and sampling on some properties, so small segments can be suppressed or approximate.
- `run_ga4_funnel_report` uses the Data API **v1alpha** surface, which is the only place funnel reporting exists. Its response shape differs from `runReport`.
- `run_ga4_cohort_report` builds a rolling cohort series from the date range, or accepts a full `cohortSpec`. GA4 rejects `dateRanges` alongside `cohortSpec`, so the cohort windows carry the dates.
- `list_ga4_custom_definitions`, `list_ga4_key_events`, and `list_ga4_data_streams` use the Admin API and are the way to confirm what a property actually measures before writing reports.

## Search Console notes

- Search Analytics returns at most **25000 rows** per request. `rowLimit` above that is clamped and reported in `notes`; page with `startRow`.
- `striking_distance` filters on average position **after** fetching, because the API cannot filter on position. It defaults to positions 5-20 with at least 10 impressions, tunable via `minPosition`, `maxPosition`, and `minImpressions`.
- `search_appearance` cannot be combined with any other dimension; Google rejects that pairing.
- `discover_performance` and `news_performance` pin `type` themselves. Discover has no query dimension.
- Query rows are anonymised, so query totals are lower than the site total, and average position cannot be summed across rows.
- The last two to three days are incomplete unless `dataState: "all"` is set.
- `compare_search_console_periods` costs **two** Search Analytics requests and returns per-key deltas plus a `new` / `lost` / `both` status. Position deltas are sign-flipped so positive always means improved.

## Meta notes (Facebook / Instagram)

### Setup

1. Create a Meta app and add the **Facebook Login for Business** product.
2. Set the redirect URI to `https://<your-domain>/auth/meta/callback`. Note there is **no** `/api` prefix: `vercel.json` rewrites every path to `api/index.js`, but Express still matches the original path.
3. Paste that URI into **Valid OAuth Redirect URIs**. The *Redirect URI Validator* on the same page is only a checker; pasting it there does not allow-list it.
4. Set `META_APP_ID` and `META_APP_SECRET`, and set `META_GRAPH_API_VERSION` to a Graph version Meta still supports.
5. Create a **Business Login Configuration** under Facebook Login for Business, select the permissions below, and copy its **Configuration ID** into `META_LOGIN_CONFIG_ID`.
6. Send the user to `/auth/meta` (`/auth/meta/start` is an alias for the same route).

### OAuth discovery

`/.well-known/oauth-authorization-server` advertises `authorization_endpoint: /auth/google/start` and lists only the Google scopes in `scopes_supported`. That is deliberate: there is no standard way to express two authorization endpoints, and Meta uses a separate flow at `/auth/meta/start`. A client requesting a Meta scope from the Google endpoint has it stripped rather than forwarded, because sending a Meta scope to Google fails with `invalid_scope`.

### Connecting from an MCP client

MCP clients only ever visit the advertised `authorization_endpoint`, which is the Google one, so a connector could never reach `/auth/meta` on its own.

**Google is required. Meta is optional.** Google consent completes the connection on its own. The user is then *asked* whether to add Meta, and both answers are a valid place to stop:

```
Add connector -> Google consent -> "Add Meta?" -> Connect Meta -> both connected
                                              \-> Skip         -> Google only
```

- **Nobody is ever sent to Facebook without choosing to.** The question screen does not auto-advance in either direction, because both outcomes are correct and picking one for the user would be picking wrongly half the time.
- A user who skips has a fully working connection. Meta tools report `no_meta_credentials` until they run `/auth/meta`.
- The Meta step carries the completed Google authorization with it, so completing Meta, denying it, failing it, or skipping it all still hand the connector a usable code. The user never loses the Google consent they already gave.
- Set `META_OFFER_AFTER_GOOGLE=false`, or pass `?include_meta=0` to `/auth/google/start`, to suppress the question entirely and finish on Google. Useful while the Meta app is unreviewed. The older `META_CHAIN_AFTER_GOOGLE` is still read as a fallback for this setting.
- `/auth/meta/skip?chain=…` finishes an in-flight Meta step with Google alone.

#### Why the flow never auto-advances into Meta

Facebook's failure screens are terminal pages that **never redirect back to `/auth/meta/callback`**, so the server's fallback logic cannot run. A user pushed there automatically is stranded with no authorization code, and the browser back button only returns them to an already-spent one. The two common screens:

| Screen | Cause |
| --- | --- |
| **App not active** | The Meta app is in Development mode, unpublished, or disabled. |
| **not a tester of this app** | The app is in Development mode and this user is not an admin, developer or tester on it. |

Both are Meta App Dashboard state, not server bugs. Every permission this server uses needs App Review before anyone outside the app's own admins, developers and testers can grant them. Until the app is Live and reviewed, a user who clicks **Connect Meta** will hit one of these — they can still return and skip, and setting `META_OFFER_AFTER_GOOGLE=false` hides the option until the app is ready.

### Login modes

`/auth/meta/start` supports two flows and picks automatically:

| | Business configuration | Raw scope list |
|---|---|---|
| Trigger | `META_LOGIN_CONFIG_ID` set, or `?config_id=` passed | neither set |
| Permissions come from | the configuration in the dashboard | the `scope` query param |
| Asset access | the user picks which ad accounts and Pages to grant | everything the user can see |
| Changing permissions | edit the configuration, no redeploy | change the URL |

**Prefer the configuration flow for anyone but yourself.** It is the least-privilege option: an agency user managing forty client ad accounts grants only the ones they choose, rather than all forty. It is also the flow Meta expects for business permissions during App Review.

When a configuration is used, the dialog receives `config_id` plus `override_default_response_type=true` (required for Login for Business to return a `code` rather than a fragment token) and `scope` is omitted. Either way, the scopes actually stored come from `debug_token`, and the callback logs whether they came from there or fell back to the requested list.

`?config_id=` on `/auth/meta/start` overrides the environment variable, which is useful for granting different clients different configurations.

### Permissions

All of these require **Meta App Review**. Until the app is approved, only its own admins, developers, and testers can grant them:

| Permission | Needed for |
|---|---|
| `ads_read` | Meta Ads insights |
| `business_management` | Business-owned ad accounts and pages |
| `pages_show_list` | Listing Pages |
| `pages_read_engagement`, `read_insights` | Page insights and posts |
| `instagram_basic`, `instagram_manage_insights` | Instagram account and media insights |

`run_meta_preset` checks the granted scopes for the surface being queried and returns a clear `insufficient_meta_permissions` error rather than a raw Meta failure.

### Tokens

- Meta has **no refresh tokens**. The callback exchanges the short-lived token for a long-lived one (about 60 days) and stores that.
- Refreshing an MCP token re-exchanges the Meta token, which resets the 60-day window. Connect at least once every 60 days and access continues indefinitely; let it lapse and the user must re-authorize.
- `get_meta_token_info` reports granted scopes, the Meta user, and `daysUntilExpiry`.
- Granted scopes come from `debug_token`, not from what was requested, because users can untick permissions in the dialog.
- Page access tokens are never returned by any tool. They are resolved server-side when a Page or Instagram preset needs one, which costs one extra Graph request (reported as `requestCount`).
- `query_meta_graph` rejects caller-supplied `access_token`, `appsecret_proof`, or `client_secret` instead of honouring them.
- Requests are signed with `appsecret_proof`, and tokens are stripped from debug logs.

### Connecting Google and Meta together

The two providers have separate flows. To hold both in **one** connector, pass an existing Google-authorized MCP token when starting the Meta flow:

```
/auth/meta/start?link_token=<existing MCP access or refresh token>
```

The resulting token carries both credential sets, so Google and Meta tools work in the same session. Without `link_token`, the Meta flow produces a Meta-only session and Google tools return `no_valid_session`.

### Known API limits

- Meta rotates and deprecates insight metric names between Graph versions. Every preset accepts a `metrics` override, and `instagram_account_overview` in particular is a common casualty. If a preset returns no rows, check `notes` and the raw error.
- Conversions are read from the `actions` array. Which `action_type` counts as a conversion depends on the pixel setup, so `conversionActionType` is configurable; the default prefers purchase-type actions and the raw `actions` array is always returned.
- Meta attributes conversions on its **own** attribution windows, so Meta conversion counts will not tie out exactly against GA4 or Google Ads. Compare trends, not absolute totals.
- Instagram follower demographics need at least 100 followers; Instagram stories only cover the last 24 hours.
- No auto-pagination. Page explicitly with the returned `nextCursor`.

## CallRail notes

### Per-user API keys

CallRail authenticates with an API key rather than OAuth. The key is collected on a connect screen at the end of the connection flow, verified against CallRail, then sealed into that user's session token the same way Meta credentials are.

**This replaces a shared server key.** Previously `CALLRAIL_API_TOKEN` was read straight from the environment on every call, and the CallRail tools performed no authorization check at all, so anyone who could reach this server's MCP endpoint could read the deployer's own call records, including caller numbers, recordings and transcripts. CallRail tools now sit behind the same token check as every other provider and use the key belonging to the calling session.

- The connect screen is the last step of setup, after Google and the optional Meta step.
- It is optional. Skipping leaves the CallRail tools switched off and changes nothing else.
- The key is posted over HTTPS, never placed in a URL, and never rendered back to the page.
- `get_callrail_connection` reports which account a session is attached to and a masked fingerprint of the key. No tool returns the key itself.
- Connect later at `/auth/callrail`, reached by running the connector setup again.

### Environment variables

| Variable | Effect |
|---|---|
| `CALLRAIL_API_TOKEN` | A shared fallback key. **Ignored unless `CALLRAIL_ALLOW_SHARED_TOKEN` is also set.** |
| `CALLRAIL_ALLOW_SHARED_TOKEN` | Set to `true` to let every user of this deployment share the key above. Only appropriate for a single-tenant deployment you control. Off by default. |
| `CALLRAIL_OFFER_STEP` | Set to `false` to drop the CallRail step from the connection flow. |

When the shared key is in use, `get_callrail_connection` returns a `sharedKeyWarning` saying so, so it is never silently in play.

- CallRail tools use `CALLRAIL_API_TOKEN` from the server environment.
- CallRail has no server-side aggregation endpoint for most groupings, so `run_callrail_preset` fetches **one page** of call records and aggregates them here. Always compare `callsFetched` against `totalRecords`; if they differ, raise `perPage` (max 250) or advance `page`. Auto-pagination is deliberately not implemented.
- Presets emit `normalizedRows` in the cross-platform schema, so calls join to Google Ads, GA4, and Search Console rows on campaign, source / medium, landing page, or date.
- A call carrying several tags is counted once per tag, so `calls_by_tag` totals can exceed the call total. This is stated in the response `notes`.
- Qualified calls are counted from `lead_status = good_lead`, which only works if the account actually scores leads.
- `answeredOnly` and `minDurationSeconds` filter calls before aggregation, which is the usual way to drop wrong numbers and hang-ups.
- ChatGPT does not perform a separate CallRail OAuth flow in this setup.
- `list_callrail_calls`, `get_callrail_call_summary`, `get_callrail_call_timeseries`, `list_callrail_trackers`, and `get_callrail_resource` accept documented CallRail query parameters via the `query` object.
- Call transcripts, call recordings, landing pages, tags, channels, sources, and attribution fields depend on what the CallRail API returns for the selected endpoint and the data available in the account.

## Deploy to Vercel

1. Import the repo into Vercel.
2. Set the environment variables above.
3. Deploy.
4. In ChatGPT, configure the connector to use your Vercel app for auth:
   - Authorization URL: `https://YOUR-VERCEL-DOMAIN/auth/google/start`
   - Token URL: `https://YOUR-VERCEL-DOMAIN/oauth/token`
   - Resource / Audience: `https://YOUR-VERCEL-DOMAIN/mcp`
5. Confirm these URLs respond:
   - `/`
   - `/debug/integrations`
   - `/.well-known/oauth-authorization-server`
   - `/.well-known/oauth-protected-resource`
   - `/mcp`
6. Reconnect the ChatGPT connector after adding new scopes such as Merchant Center or Google Ads so the new Google scopes are granted.

## Local development

```bash
npm install
npm run dev
```

Or run the Express server directly:

```bash
npm start
```

## Notes

- This server keeps OAuth state stateless by encrypting authorization codes and Vercel-issued access and refresh tokens instead of storing them in a database.
- Keep `APP_ENCRYPTION_KEY` or `SESSION_SECRET` stable across deploys so sessions and tokens remain decryptable.
- `/mcp` validates only Vercel-issued MCP bearer tokens. It does not accept raw Google tokens directly.
- Those Vercel-issued tokens include issuer, resource, scope, expiry, and the Google credentials needed for downstream Google API calls.
- The current server-side session store is in-process memory. For stronger persistence across cold starts and regions on Vercel, move session storage to a durable store such as Redis or Vercel KV.
- When Google OAuth scopes change, old refresh tokens may not carry the new scopes. Disconnect and reconnect ChatGPT if you see insufficient scope errors after deploying.
