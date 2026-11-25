---
name: google-ads-audit
description: Audit a Google Ads account for wasted spend, missed volume and tracking gaps, and return prioritized fixes. Use when asked to audit, optimize or explain the performance of Google Ads campaigns.
metadata:
  arguments: customer, period
  tools: list_google_ads_accessible_customers list_google_ads_customer_clients run_google_ads_preset query_google_ads google_ads_keyword_planner run_ga4_preset
---

# Google Ads audit

Spend should follow profit. Find where money is wasted, where volume is capped, and whether conversions can be trusted.

## 1. Account and trust check
1. `list_google_ads_accessible_customers`, plus `list_google_ads_customer_clients` for a manager account.
2. `run_google_ads_preset` `conversion_actions`: which actions are primary, counting "every" or "one", and their attribution model. Wrong primary actions make every other number misleading, so fix those first.
3. `account_overview` for the last 30 days against the previous 30.

## 2. Wasted spend
- `search_terms`: terms with spend and no conversions. Suggest negatives, and check `negative_keywords` and `shared_set_negative_keywords` for conflicts.
- `keyword_performance` and `quality_score`: low QS keywords with high spend. Fix ad relevance or the landing page, or pause.
- `pmax_search_terms` and `placement_performance`: junk placements and off-brand queries.
- `device_performance`, `geo_performance` and `ad_schedule_performance`: segments with CPA well above target.

## 3. Missed volume
- `impression_share`: lost to budget means scale the winners. Lost to rank means fix bids or quality before spending more.
- `campaign_budgets`: limited campaigns that also hit the CPA or ROAS target.
- `google_ads_keyword_planner` for converting themes with no coverage yet.

## 4. Cross-check
Compare Ads conversions with `run_ga4_preset` `google_ads_performance`. A large gap means tracking or attribution problems, so say so before recommending budget moves.

## 5. Output
Ranked actions: action, campaign or ad group, evidence, monthly spend saved or conversions gained, and risk. Never apply changes yourself: these tools are read-only by design.
