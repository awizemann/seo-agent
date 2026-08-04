---
title: Core Pipeline Architecture
type: note
permalink: seo-agent/architecture/core-pipeline-architecture
tags: [architecture, pipeline]
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [design] Five-stage pipeline: **Crawl** (fetch sitemap, HTMLRewriter snapshot to D1) → **Diagnose** (deterministic rules emit findings) → **Generate** (async queue, one job per finding, Workers AI proposals capped per run) → **Act** (KV overrides, no auto-apply default) → **Sense** (optional GSC, AEO telemetry, citations) #pipeline
- [trigger] Daily cron job or on-demand via `POST /run` endpoint #operations
- [contract] **KV override contract** with injector: key = `override:<pathname>`, value = `{title?, description?}`. Injector reads with `cacheTtl: 300` and **fails open** (KV error/miss preserves computed meta unchanged) #integration
- [design] Queues isolate drafting from request path: `GenerateStep` enqueues async jobs, queue consumer drafts one at a time. Slow model calls retried independently, never block the run or exhaust budget #async
- [validation] Drafted proposals validated hard (length windows, complete sentence, no quotes); invalid drafts dropped and re-enqueued next run #validation
- [control] Nothing auto-applies unless explicitly configured in `AUTO_APPLY_FIELDS` (empty by default) #safety

## Relations
- depends_on [[Cloudflare Workers Stack]]
- implements [[Design Principles & Safety]]
- includes [[AEO/GEO Checks & AI Answer Engines]]
