---
name: merchant-center-health
description: Check Google Merchant Center product feed health, disapprovals, price competitiveness and best-seller gaps. Use when Shopping or Performance Max products are disapproved, impressions drop, or when asked how a product feed is doing.
metadata:
  arguments: merchant_account
  tools: list_merchant_accounts get_merchant_account_issues get_merchant_product_status_summary run_merchant_preset list_merchant_data_sources run_google_ads_preset
---

# Merchant Center health

## 1. Account level
1. `list_merchant_accounts` and pick the account.
2. `get_merchant_account_issues`: account-level problems (misrepresentation, website claim, shipping) come first because they suspend everything.

## 2. Product level
- `get_merchant_product_status_summary`: approved, limited and disapproved counts by destination.
- `run_merchant_preset` `product_status`: group disapprovals by issue code and fix the code that affects the most products first (usually price mismatch, missing GTIN or images).
- `list_merchant_data_sources`: when the feed last fetched and whether it had errors.

## 3. Competitiveness
- `run_merchant_preset` `price_competitiveness` and `price_insights`: products priced well above the benchmark with high impressions are losing clicks.
- `best_sellers` and `best_sellers_brands`: popular products in your categories that you do not carry, or carry with no stock.
- `product_performance`: products with impressions and no clicks have a title or image problem.

## 4. Tie to ads
`run_google_ads_preset` `shopping_performance` and `pmax_asset_groups` to see whether disapproved or overpriced products were the top spenders.

## 5. Output
Issue, products affected, fix and expected impact, ranked by the number of products or revenue at risk.
