# Google Business Profile MCP module

This folder registers Google Business Profile tools in the existing MCP server. It uses the same Google OAuth connection, with the `https://www.googleapis.com/auth/business.manage` scope. The module is disabled unless `ENABLE_GBP=1` (or `true`/`yes`) is set on the server.

## Activate

1. In the approved Google Cloud project, enable the Business Profile API families used here: Account Management, Business Information, Performance, Place Actions, Lodging, and Google My Business API. Access to one family does not guarantee access to every other family or every location.
2. Set `ENABLE_GBP=1` in the deployed environment and redeploy.
3. Reconnect the ChatGPT MCP connection so Google grants the new `business.manage` scope. Existing tokens cannot gain a new scope silently.
4. Inspect `/debug/integrations`: `env.ENABLE_GBP`, `googleScopesSupported`, `toolCoverage.googleBusinessProfileTools`, and the authenticated session scopes. Try `gbp_list_accounts`, then `gbp_list_locations` with the chosen account ID.

The approved Cloud project quota and a connected Google user's location access are separate requirements. No GBP credential or API key is stored in this folder.

## Boundaries

- Account admins, location admins, and invitations are read-only. The module cannot invite, remove, change roles, accept/decline, or transfer.
- Locations, selected profile fields, attributes, posts, and business-owned media have dedicated write tools that require `confirmed: true`. The review write tool can publish a **first** owner reply only; it refuses a review that already has a reply.
- Verification and Notifications tools are excluded. Booking/action links, lodging, service lists, and food menus are read-only.
- API availability varies by account role, location status, country, business category, and product eligibility. A successful project allowlist decision is not proof that every tool will work for every location.
- GBP performance is not interchangeable with Ads, GA4, Search Console, or CallRail measures. Monthly discovery keywords are impression counts only. The My Business Business Calls API was discontinued in 2023; GBP exposes call-button clicks through Performance, not answered/missed call history, recordings, or transcripts.

Run the transport tests with `node --test "MCP GBP/tools.test.js"`. They mock Google responses; they do not prove live account access.
