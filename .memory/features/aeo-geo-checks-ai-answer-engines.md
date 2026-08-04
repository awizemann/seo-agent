---
title: AEO/GEO Checks & AI Answer Engines
type: note
permalink: seo-agent/features/aeo-geo-checks-ai-answer-engines
tags: [aeo, geo, ai-engines]
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [feature] Checks whether AI engines (ChatGPT, Claude, Perplexity, Google AI Overviews, Copilot) can crawl, read, and cite the site — no JavaScript execution at index or answer time #ai-engines
- [rules] Nine diagnostic rules: `ai_page_body_empty` (high, <200 chars body or no articleBody JSON-LD), `ai_page_blocked` (high, 403/429/451 to AI-bot UA), `robots_blocks_ai_bot` (high, `/` blocked in robots.txt), `llms_txt_soft_404` (high, catches HTML shell at /llms.txt), `robots_txt_unreachable` (med), `llms_txt_missing` (med), `robots_no_ai_policy` (info), `llms_full_txt_missing` (info), `aeo_check_error` (info, transient fetch failure) #rules
- [config] `AEO_CHECKS` (default on; set `"false"` to disable), `AEO_BOT_UA` (defaults to GPTBot user agent). Sample prefers pages under `ARTICLE_PATH_PREFIX`, falls back to all content, rotates day-to-day #configuration
- [semantics] AI bots do not execute JavaScript — CSR SPAs serving empty shells are invisible. Blocking answer-engine crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Meta-WebIndexer, etc.) silently removes you from citations. Training-only crawlers (GPTBot, ClaudeBot, CCBot, etc.) are a policy choice with **zero citation cost** either way #ai-semantics
- [best_practice] `llms.txt` is cheap insurance, not a lever — answering 200 with HTML shell is **worse than 404** because it feeds agents misleading content. Soft-404s are actively harmful #best-practice
- [remediation] CSR SPA fixes (in order of strength): server-side/static rendering; **AI content lane** (detect AI-bot UAs, inject full content HTML into body, send `Vary: User-Agent`; exclude Googlebot/Bingbot); full text in Article JSON-LD `articleBody` fallback #remediation
- [best_practice] Recommended robots.txt structure: explicit groups for answer-engine crawlers (allow), training-only crawlers (configurable, recommend allow for reach), and catch-all. Example provided in README #best-practice

## Relations
- part_of [[Core Pipeline Architecture]]
- related_to [[AI Traffic Telemetry & Analytics]]
- related_to [[Citation Probes & Engine Tracking]]
