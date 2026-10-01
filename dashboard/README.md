# Marketer Companion ChatGPT app

This adds an MCP Apps dashboard to the existing Vercel server at
`https://ga4mcpjs.vercel.app/mcp`. The existing OAuth system and data tools remain
in place. No OpenAI API key or additional backend database is required.

## Included

- `open_marketing_dashboard`: ChatGPT global sidebar and conversation panel entrypoints.
- `list_dashboard_accounts`: available GA4 properties, Search Console sites and Ads IDs.
- `get_marketing_dashboard`: authenticated reports for selected accounts.
- Three views: website traffic, organic search, paid campaigns.
- Dates, previous-period comparisons, trends, top-ten breakdowns and chat analysis.
- Responsive layout and host-provided light/dark theme.

The first version includes GA4, Search Console and Google Ads. It does not
include Meta, Merchant Center, CallRail or GBP dashboard views.

## Build and deploy

1. Apply the supplied Git patch to the repository, or copy the changed source files.
2. Run `npm ci`, `npm run build:dashboard`, and `npm test`.
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

The frontend uses MCP Apps SDK `@modelcontextprotocol/ext-apps` 1.2.0, compatible
with this repository's Zod 3 stack. The HTML has no external script, font or
image dependencies. OpenAI UI metadata follows the published MCP Extensions
display-mode and entrypoint definitions.

## Dashboard motion

GSAP is bundled into the dashboard HTML at build time; the deployed widget loads no animation CDN and makes no extra server calls. Source changes use a short staggered KPI reveal, a gentle panel rise and an SVG line draw. Values always show the final reported numbers. Switching sources cancels and restores the previous animation before rendering the next view. Motion is disabled for `prefers-reduced-motion`, including when the preference changes while the widget is open.
