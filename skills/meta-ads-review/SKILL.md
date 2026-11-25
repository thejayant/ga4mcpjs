---
name: meta-ads-review
description: Review Meta (Facebook and Instagram) ad performance, creative fatigue and audience efficiency, with clear next steps. Use when asked how Meta or Facebook ads are doing, which creatives to cut, or where to move budget.
metadata:
  arguments: ad_account, period
  tools: list_meta_ad_accounts run_meta_preset run_meta_insights describe_meta_insights_fields search_meta_ad_library run_ga4_preset
---

# Meta ads review

## 1. Scope
`list_meta_ad_accounts` and pick the account. Default period: last 14 days against the previous 14 (Meta optimizes in short cycles).

## 2. Pull
`run_meta_preset`: `ads_account_performance`, `ads_campaign_performance`, `ads_adset_performance`, `ads_ad_performance`, `ads_daily_trends`, `ads_by_placement` and `ads_by_age_gender`. Use `run_meta_insights` for anything custom (check fields with `describe_meta_insights_fields`).

## 3. Diagnose
- **Creative fatigue**: frequency above about 3 with CTR falling and CPM rising across the period. Refresh the creative, not the audience.
- **Learning limited**: ad sets with under about 50 optimization events a week. Consolidate them instead of adding more.
- **Placement waste**: placements with a CPA far above the account average (`ads_by_placement`).
- **Funnel break**: link clicks are fine but landing page views are low, which means slow pages or tracking loss. Cross-check sessions from Meta in GA4 (`run_ga4_preset` `source_medium`).
- **Competitors**: `search_meta_ad_library` for active competitor creatives and angles worth testing.

## 4. Output
Keep, cut, scale and test lists, each with the numbers behind it. Note attribution window differences when Meta and GA4 disagree.
