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
- `list_ga4_properties`
- `run_ga4_report`
- `get_ga4_metadata`
- `check_ga4_compatibility`
- `batch_run_ga4_reports`
- `run_ga4_realtime_report`
- `run_ga4_pivot_report`
- `run_ga4_preset`
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
- `list_callrail_accounts`
- `list_callrail_companies`
- `list_callrail_calls`
- `get_callrail_call`
- `get_callrail_call_summary`
- `get_callrail_call_timeseries`
- `list_callrail_trackers`
- `get_callrail_resource`
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

- Google Ads access is intentionally query-driven. `query_google_ads` and `search_stream_google_ads` use GAQL, which is the primary supported way to fetch campaigns, ad groups, ads, keywords, assets, audiences, conversions, channels, segments, search terms, and most reporting data.
- GA4 access is intentionally metadata-driven plus report-driven. `get_ga4_metadata` and `check_ga4_compatibility` let ChatGPT discover valid dimensions, metrics, attributes, and filter compatibility before running `run_ga4_report`, `run_ga4_realtime_report`, `run_ga4_pivot_report`, or `batch_run_ga4_reports`.
- Search Console supports Search Analytics, Sites, Sitemaps, and URL Inspection. The aggregate Search Console UI Index Coverage report is not exposed as a matching public API; `inspect_search_console_url` is the URL-level API alternative.
- CallRail support is read-only and centered on calls, summaries, time series, trackers, and generic read-only JSON endpoints via `get_callrail_resource`.
- The expert preset layer is designed for common analyst workflows, while the raw tools remain available for deeper custom work.

## Expert Layer

- `run_google_ads_preset` supports:
  `campaign_performance`, `ad_group_performance`, `keyword_performance`, `search_terms`, `asset_performance`, `conversions_by_campaign`
- `run_ga4_preset` supports:
  `channels`, `landing_pages`, `source_medium`, `campaigns`, `key_events`, `ecommerce`, `attribution_breakdown`
- `run_search_console_preset` supports:
  `queries`, `pages`, `countries`, `devices`, `date_trends`, `branded_vs_non_branded`
- `run_merchant_preset` supports:
  `product_performance`, `product_status`, `price_competitiveness`, `price_insights`, `best_sellers`, `competitive_visibility`
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
- Use `search_google_ads_fields` and `get_google_ads_field` first when you need to discover valid fields, segments, metrics, and filters before writing GAQL.

## CallRail notes

- CallRail tools use `CALLRAIL_API_TOKEN` from the server environment.
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
