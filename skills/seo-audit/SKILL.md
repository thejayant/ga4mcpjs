---
name: seo-audit
description: Run a data-driven SEO audit from Search Console, Bing Webmaster, Clarity and GA4, and return a ranked fix list. Use when asked for an SEO audit, why organic traffic dropped, or which pages and queries to improve.
metadata:
  arguments: site, period
  tools: list_search_console_sites run_search_console_preset compare_search_console_periods query_search_console_advanced inspect_search_console_url list_search_console_sitemaps bing_webmaster_traffic bing_webmaster_queries clarity_insights run_ga4_preset
---

# SEO audit

Answer three questions with data: what is losing, what is close to winning, and what is broken.

## 1. Baseline (Search Console)
1. `list_search_console_sites` and pick the property (prefer the `sc-domain:` property).
2. `compare_search_console_periods`: last 28 days against the previous 28, and against the same period last year to rule out seasonality.
3. `run_search_console_preset` with `queries`, `pages`, `branded_vs_non_branded` and `devices`.

## 2. Find the money
- **Striking distance**: `run_search_console_preset` `striking_distance` (positions 4 to 20 with real impressions). These are the cheapest wins: improve the title, H1, internal links and content depth.
- **Low CTR at good positions**: position under 5 and CTR well below that position's typical rate. Rewrite the title and meta description.
- **Decliners**: pages or queries that lost the most clicks between periods. Check whether position or impressions dropped (ranking loss) or only CTR (a SERP feature or snippet change).
- **Cannibalization**: `query_page_pairs` where two or more URLs share one query. Merge them or pick one canonical.

## 3. Technical checks
- `list_search_console_sitemaps`: errors, and submitted versus indexed counts.
- `inspect_search_console_url` on the top 5 decliners and top 5 striking-distance pages: indexing state, canonical, mobile usability.
- Bing (`bing_webmaster_traffic`, `bing_webmaster_queries`): Bing also feeds ChatGPT and Copilot search, so a gap there costs AI visibility too.

## 4. Behavior after the click
- `run_ga4_preset` `landing_pages` filtered to organic: engagement rate and key events per landing page.
- `clarity_insights`: rage clicks, dead clicks and quick backs on the top organic pages. Traffic without engagement means a content or UX problem, not an SEO one.

## 5. Output
A table ranked by expected clicks gained: page or query, issue, evidence (numbers), fix, effort (S, M or L). Put the top 5 first. Say clearly when data is thin (under about 100 impressions) instead of guessing.
