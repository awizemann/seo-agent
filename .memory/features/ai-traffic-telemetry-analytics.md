---
title: AI Traffic Telemetry & Analytics
type: note
permalink: seo-agent/features/ai-traffic-telemetry-analytics
tags: [telemetry, analytics, aeo]
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [feature] Edge-based analytics: records which AI engines read the site. GA cannot see bots (they don't execute JS); telemetry tap captures what the edge sees #telemetry
- [setup] Bind agent's D1 to injector as `TELEMETRY`; insert into `aeo_hits` table (proxy injector provides ~30-line `tapAeo()` helper; Worker-fronted sites copy the helper and insert directly) #setup
- [records] AI-relevant traffic only: bot UA + path + status + served format (markdown twin / AI content lane / plain HTML); human clicks with AI engine Referer (chatgpt.com, perplexity.ai, claude.ai, gemini, copilot, …); markdown-lane responses #schema
- [lifecycle] Fire-and-forget via `waitUntil`, fail-open (no errors cascade). Pruned after 90 days. **Weekly rollups** into `aeo_weekly` (written once per ISO week, never overwritten) only while data exists in 90d retention #retention
- [findings] `ai_crawlers_silent` (info, tap active ≥14d but zero hits) and `ai_crawler_errors` (info, bot >20% errors on content-only responses) — low-noise findings from telemetry #findings
- [access] Displayed: dashboard cards (AI crawls / AI referrals, 7d), `GET /aeo/hits` endpoint, MCP `list_crawler_hits` tool #api

## Relations
- part_of [[Core Pipeline Architecture]]
- depends_on [[Cloudflare Workers Stack]]
- related_to [[AEO/GEO Checks & AI Answer Engines]]
