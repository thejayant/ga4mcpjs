# Marketer Companion ChatGPT app

This adds an MCP Apps dashboard to the existing Vercel server at
`https://ga4mcpjs.vercel.app/mcp`. The existing OAuth system and data tools remain
in place. No OpenAI API key or additional backend database is required.

## Included

- `open_marketing_dashboard`: ChatGPT global sidebar and conversation entrypoints.
  ChatGPT can pass account IDs for one business so the dashboard opens preloaded.
- `list_dashboard_accounts`: GA4 properties, Search Console sites, Google Ads
  customers, Merchant Center accounts, Business Profile locations and CallRail accounts.
- `get_marketing_dashboard`: authenticated reports for the selected accounts.
- Views: a cross-channel **Overview** with ranked signals (biggest movers, product
  disapprovals, unanswered reviews, missed calls, spend rising while conversions fall),
  then Website (GA4), Organic search (GSC), Google Ads, Merchant Center, Business
  Profile and Calls (CallRail).
- Every view: animated stat tiles with period deltas, a trend chart with the previous
  period overlaid and a hover/keyboard readout, ranked tables with inline bars, and
  share bars. Merchant shows product status per destination and the issues to fix;
  Business Profile shows reviews, actions and search keywords; CallRail shows answer
  rate, sources and campaigns.
- Motion: staggered reveals, count-up figures, line drawing and sheet transitions via
  the Web Animations API. Readers who prefer reduced motion get the final view at once.
- Light and dark themes from the host, responsive down to phone width.

Business Profile appears only when `ENABLE_GBP` is on. CallRail uses the connection's
own CallRail token (or the internal server's token on `/cbx`); without one, that source
reports "connect CallRail" and every other source still loads.

## Build and deploy

1. Apply the supplied Git patch to the repository, or copy the changed source files.
2. Run `npm run build:dashboard` (no packages needed; esbuild minifies if installed),
   then `npm test`. `node dashboard/preview.mjs <playwright index.mjs> <out dir>` renders
   every view in a simulated host with test fixtures and saves screenshots.
3. Commit and push the change to the branch Vercel deploys, or merge the reviewed
   feature branch into that branch. Keep all existing Vercel environment variables.
4. The dashboard is disabled by default. Test the existing MCP tools first.
   On a preview deployment, set `ENABLE_MARKETING_DASHBOARD=true` and redeploy
   to enable the three dashboard tools. Only enable it in Production after review.
   Verify the enabled deployment's root JSON lists the three dashboard tools.
5. Install the private Marketer Companion Dashboard plugin, connect its MCP
   server through Google OAuth, and ask: “Open my marketing dashboard.”
6. Refresh tool discovery/reconnect the plugin if the host cached the old tool catalog.
7. Select corresponding GA4, GSC and Ads accounts and load the dashboard.

`dashboard/dist/dashboard.html` is bundled and checked in so Vercel does not
need a separate frontend build step. `vercel.json` explicitly includes the HTML
in the serverless function. Rebuild the bundle whenever UI source changes.

## What has and has not been verified

Automated checks cover authenticated MCP discovery and resource reading, opener
defaults, metric normalization, ranges, scoped failures, micros conversion and
existing route/GBP behavior. Fixtures in tests are synthetic; they are never
used as dashboard fallback data.

Browser checks with a simulated MCP Apps host passed for source tabs, KPI
formatting, partial report failures, selected-view context sharing, stale-filter
protection, mobile overflow and HTML escaping. This does not verify the live
ChatGPT host or production API data.

Production Google data and actual ChatGPT sidebar placement must be checked
after deploying the server update and completing the user's OAuth connection.
The plugin package alone does not deploy code to Vercel.

## Controlled rollout and rollback

Use a new Git branch and preview deployment before merging to your production
branch. Existing scopes, OAuth routes, tokens, public/internal access checks and
tool handlers are not modified by this update. The existing MCP SDK, Zod,
Express and Google API versions in the lockfile are unchanged.

Without `ENABLE_MARKETING_DASHBOARD=true`, the server does not register or
advertise the dashboard. If the enabled dashboard needs to be withdrawn, set
the flag to `false` and redeploy. For a server-wide regression, redeploy the
previous known-good commit; the flag only controls dashboard registration.

A live OAuth preview needs its own correct `APP_BASE_URL` and a Google OAuth
redirect URI registered for that preview URL. Do not change the production
callback to test a preview. If those preview credentials are not configured,
run the automated tests and test unauthenticated MCP responses in preview;
they do not prove live Google reporting or OAuth compatibility.

## Metric rules

- GA4 active users come from the whole-period query, not a sum of daily users.
- GSC KPI totals come from a query without query/page dimensions; anonymised
  queries and top-ten limits mean detail tables will not necessarily reconcile.
- Google Ads spend converts cost micros once; fractional conversions are retained.
- Conversion figures retain their source definitions and are not combined.
- Revenue/spend currency and source reporting time zones remain source-specific.
- Defaults are 28 days ending three days ago, not a guarantee of finalized data.
- Tables explicitly identify limited results. Failed requests show errors, not zeros.
- Data stays in the active app view. “Analyse this view” sends the selected
  source's report to the current ChatGPT conversation only when clicked.
- There is no automatic refresh or background schedule in this version.

## Maintain

The frontend has no runtime dependencies. `bridge.js` speaks the MCP Apps protocol
(JSON-RPC over `postMessage`: `ui/initialize`, `tools/call`, `ui/message`,
`ui/update-model-context`, tool-result and host-context notifications) directly, and
`motion.js` uses the Web Animations API, so the built page is about 90 KB instead of
500 KB and makes no external requests. `build.js` inlines `app.js` and the modules it
imports, each in its own scope.

The resource URI carries a version (`ui://marketing/dashboard-v2.html`) because hosts
cache UI resources by URI. Bump it whenever the HTML changes in a way users must see.
