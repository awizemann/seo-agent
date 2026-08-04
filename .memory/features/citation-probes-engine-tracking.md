---
title: Citation Probes & Engine Tracking
type: note
permalink: seo-agent/features/citation-probes-engine-tracking
tags: [citations, aeo, probes]
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [feature] Outcome metric: do engines cite you for your chosen queries? Tracks whether you appear in ChatGPT, Claude, Perplexity, Gemini, Copilot answers for keywords you care about #feature
- [config] `CITATION_QUERIES` (10–30 queries, JSON array or `|`-separated), at least one engine key: `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` #configuration
- [cost] Gemini (Google-Search grounding) ≈$0/month within free tier (requires **billing-linked** Google project; unbilled keys get instant 429s). Alternatives ~$1–2/month at weekly probe volume #cost
- [cadence] Weekly on daily cron (`CITATION_CRON_DAY`, default Monday UTC, idempotent per day) or on-demand via `POST /aeo/citations/run` / MCP `run_citation_check` #operations
- [results] Per engine × query: cited (yes/no), rank among sources, cited URL. Findings: `citation_lost` (medium, stays open until regained) and `citation_gained` (info) #findings
- [caveat] Engine APIs are a proxy for consumer UIs (different retrieval stacks). Track deltas, not absolutes; absolute counts are unreliable #limitations

## Relations
- part_of [[Core Pipeline Architecture]]
- related_to [[AEO/GEO Checks & AI Answer Engines]]
