---
name: ga4-performance-review
description: Produce a weekly or monthly GA4 performance review covering traffic, channels, conversions and anomalies, with clear actions. Use when asked how the site is doing, for a GA4 report, or to explain a change in traffic or conversions.
metadata:
  arguments: property, period
  tools: list_ga4_properties check_ga4_compatibility batch_run_ga4_reports run_ga4_preset run_ga4_report run_ga4_funnel_report list_ga4_key_events run_ga4_realtime_report
---

# GA4 performance review

## 1. Set up
1. `list_ga4_properties` and confirm the property and its time zone.
2. `list_ga4_key_events` so you report the conversions the business actually counts, not every event.
3. Pick the period (default: last full week, Monday to Sunday) and compare it with both the previous period and the same period last year.

## 2. Pull everything in one go
Use `batch_run_ga4_reports` (one call, up to 5 reports) instead of many single calls:
- Totals: sessions, engaged sessions, key events, revenue.
- By `sessionDefaultChannelGroup`.
- By landing page (top 20).
- By device category.
- Daily trend (`date`) for anomaly spotting.
Before any custom dimension and metric mix, run `check_ga4_compatibility`.

## 3. Read it like an analyst
- Lead with the one number that matters to the business (key events or revenue), then explain it with channels.
- A change only matters if it is big enough: ignore moves under about 10% on small numbers (under about 200 sessions).
- Split every change into volume (sessions) and rate (conversion rate). They need different fixes.
- Flag tracking problems before performance problems: a sudden 0, a 2x spike in direct traffic, or "(not set)" growth usually means broken tagging, not real users.
- For checkout or sign-up drops, use `run_ga4_funnel_report` to find the step that broke.

## 4. Output
1. Three-line summary: what happened, why, and what to do.
2. A KPI table with the current value, the change against the previous period and the change against last year.
3. Up to 5 actions, each tied to a number in the report.
