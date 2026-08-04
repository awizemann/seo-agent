---
title: Google Search Console Sensing (Optional)
type: note
permalink: seo-agent/features/google-search-console-sensing-optional
tags: [gsc, sensing, analytics]
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [feature] Optional but recommended — ingests GSC metrics (impressions, clicks, CTR, position) for CTR optimization and before/after measurement of applied changes #feature
- [setup] Google Cloud project + GSC API enabled; service account + JSON key. Set `GSC_SERVICE_ACCOUNT_JSON` (secret, never commit) and `GSC_PROPERTY` (domain `sc-domain:example.com` or URL-prefix property type) #setup
- [backfill] Trailing ~3-day window per run. On first run, if <30 distinct dates exist, backfills ~90d (date-chunked, paged, capped at 40 API calls). Idempotent via `INSERT OR REPLACE`. One-shot trigger: once 30 dates exist, backfill never runs again #lifecycle
- [schema] Daily granule: clicks, impressions, CTR, position summed across all pages for 90 days. Read-only, computed by `analytics.ts` #schema
- [change_impact] Compares GSC metrics **before** (ending day before change) and **after** (starting 4 days later, after 3d settle) at two ages: **d14** (14-day windows, judged at ~change+18d) and **d28** (28-day, judged at ~change+31d). Windows compared as per-day rates (impressions/clicks) or impression-weighted averages (CTR, position) #analytics
- [verdict] Verdict is a pure, unit-tested function with named thresholds: `insufficient_data` if <50 total impressions across two windows. Frozen once d28 verdict lands; reverted changes get no new verdicts #verdict

## Relations
- part_of [[Core Pipeline Architecture]]
- depends_on [[Cloudflare Workers Stack]]
