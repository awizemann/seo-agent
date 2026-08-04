---
title: Diagnostic Rules & Findings Lifecycle
type: note
permalink: seo-agent/features/diagnostic-rules-findings-lifecycle
tags: [diagnosis, rules, findings]
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [design] Deterministic rules emit findings keyed `(path, rule)`, each with open/auto-resolve lifecycle (states: open → proposed → approved → applied / auto-resolved / reverted) #design
- [seo_rules] SEO rules: injection regressions, missing/short/long descriptions, canonical mismatches, sitemap errors/redirects, duplicate titles, missing Article JSON-LD, noindex-in-sitemap, long titles, new/removed pages #seo
- [aeo_rules] AEO/GEO rules: nine rules (see [[AEO/GEO Checks & AI Answer Engines]]) #aeo
- [workflow] Description-quality findings enqueue drafting jobs (capped at `MAX_PROPOSALS_PER_RUN`). Each job drafted async via queue consumer. Findings surface on dashboard, API, MCP #workflow
- [principle] Rules must be reproducible, not heuristic — same input always produces same finding. Enables reliable diff-based detection (new/resolved pages) #determinism

## Relations
- part_of [[Core Pipeline Architecture]]
- implements [[Design Principles & Safety]]
