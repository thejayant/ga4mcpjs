---
name: clarity-ux-review
description: Find and prioritize UX problems on a site with Microsoft Clarity, from product page friction to quote and designer funnels, campaign landing pages, recordings to watch, heatmap checks and a 14-day client report. Use when asked what to fix on product pages, why visitors drop off, how campaigns' landing pages perform, or for a Clarity client report.
metadata:
  arguments: project, focus
  tools: clarity_list_projects clarity_friction_report clarity_funnel_report clarity_campaign_scorecard clarity_period_report clarity_recordings clarity_heatmap_review clarity_dashboard_query clarity_insights run_ga4_report run_ga4_funnel_report list_ga4_key_events
---

# Clarity UX review

## 0. Know the limits before you spend requests
- Each Clarity project allows **10 Data Export requests a day**, covering only the **last 1 to 3 days**. The friction, funnel and heatmap reports share one cached URL × device pull, so run them back to back with the same `numOfDays` (default 3). The campaign scorecard costs one or two more.
- Recordings and `clarity_dashboard_query` use Clarity's MCP API, with its own daily limit. Use the dashboard query for anything older than 3 days, exact date ranges and deduplicated users.
- No Clarity API returns heatmap click maps. Say so, and send the user to the heatmap link for the visual check.
- Clarity has no conversions. Get them from GA4 key events.

## 1. Set up
1. `clarity_list_projects`. With several projects, confirm which one (by name or site) and pass `project` on every call. If the project the user names isn't connected, give them `addProjectUrl` and stop.
2. If the site has GA4, run `list_ga4_key_events` to know which conversions count (quote request, designer save, contact).

## 2. Product Page Friction Report
`clarity_friction_report` with `urlContains` set to the product URL pattern (ask once if unsure, e.g. `/products/`). Rank by `frictionSessions`, but explain each page by its strongest signal:
- Dead clicks: something looks clickable and isn't (images, specs, swatches).
- Rage clicks: a control that is slow or broken.
- Quick backs: the page didn't match what the visitor expected (ad promise, price, availability).
- Error clicks and script errors: a bug. Fix these first; they are the cheapest wins.
Compare Mobile with PC for the same page; a mobile-only spike is a layout problem.

## 3. Mobile Quote and 3D Designer Funnel
`clarity_funnel_report` with device `Mobile` and steps such as product page → quote form → 3D designer → thank-you page. Use `smartEvent` for steps tracked as Clarity Smart Events (e.g. `RequestQuote`). It is step reach, not a strict funnel. When the same steps are GA4 events, also run `run_ga4_funnel_report` for the exact ordered funnel over a longer period, and lead with the GA4 numbers where they disagree. Name the step in `biggestDrop` and what to test there.

## 4. Campaign Landing Page Scorecard
`clarity_campaign_scorecard` (view `both`). Then run its `ga4Join` call (`run_ga4_report`) and match rows on campaign and landing page. A campaign that sends engaged visitors (deep scroll, long active time) but few key events has a landing page or offer problem; one with high quick-backs has an ad-to-page mismatch.

## 5. 14-Day Client Report
`clarity_period_report` (days 14). Check `coverage` first. If either period is short of days, say so and fill the totals with `clarity_dashboard_query` using explicit dates ("Sessions from 2026-11-01 to 2026-11-14"), or ask for the Clarity dashboard CSV. Report counts with their change, and rates in points. `userDays` is not a unique user count; get deduplicated users from the dashboard query.

## 6. Recording Review Queue
`clarity_recordings` for the worst page from step 2: its URL, device, and the signal that ranked it (e.g. `friction: ["rageClicks"]`), sorted `SessionClickCount_DESC`, count 10 to 20. List each recording link with one line on what to watch for.

## 7. Heatmap Review
`clarity_heatmap_review` for that page with `ctaText` set to the quote button's text. Report scroll depth by device against where the CTA and specs sit, and the CTA click share of the sample (a sample, not a rate). Give the heatmap link and three things to check there. Recommend a Smart Event on the CTA if it isn't tracked yet.

## Output
1. Three-line summary: the biggest problem, where, and the fix.
2. A ranked fix list (page, problem, evidence number, suggested fix, effort S/M/L), at most 7 items.
3. The recordings to watch and the heatmaps to open, as links.
4. What the data can't show, in one line (e.g. older than 3 days without snapshots, no heatmap API).
