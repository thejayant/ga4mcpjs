---
name: local-business-growth
description: Grow a local business through Google Business Profile reviews, posts and profile quality, tied to calls from CallRail. Use for local SEO, GBP or Google Maps work, review replies, or explaining phone-call leads.
metadata:
  arguments: location, period
  tools: gbp_list_accounts gbp_list_locations gbp_get_location gbp_review_backlog gbp_publish_review_reply gbp_list_posts gbp_create_post gbp_get_daily_performance gbp_get_monthly_search_keywords run_callrail_preset
---

# Local business growth

## 1. Profile health
1. `gbp_list_accounts`, `gbp_list_locations`, then `gbp_get_location` for the location.
2. Check that categories, hours, website (with UTM tags), phone, service area and description are complete and accurate. A wrong primary category hurts more than anything else.

## 2. Reviews (the biggest ranking and conversion lever)
1. `gbp_review_backlog`: rating, unanswered count and the oldest unanswered review.
2. Draft replies: thank the reviewer by name, mention the specific service, and keep each under 80 words. For negative reviews, acknowledge the issue, take it offline, and never argue or share private details.
3. Show the drafts to the user and only call `gbp_publish_review_reply` after approval.

## 3. Visibility and demand
- `gbp_get_daily_performance`: calls, direction requests, website clicks and impressions (Maps versus Search).
- `gbp_get_monthly_search_keywords`: what people search to find the business. Feed these words into posts and the description.
- `gbp_list_posts`: post at least weekly. Use `gbp_create_post` for offers and updates, after approval.

## 4. Calls (CallRail)
`run_callrail_preset` `calls_by_source`, `answered_vs_missed` and `first_time_vs_repeat`. Missed first-time calls from GBP are lost leads: report them with the hours they happen, because that is usually a staffing fix.

## 5. Output
A scorecard (rating, review velocity, response rate, calls, missed-call rate) and the top 5 actions.
