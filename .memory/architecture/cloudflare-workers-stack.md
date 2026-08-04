---
title: Cloudflare Workers Stack
type: note
permalink: seo-agent/architecture/cloudflare-workers-stack
tags: [architecture, stack, cloudflare]
source_paths: [package.json]
source_paths_inferred: false
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [requirement] Requires Cloudflare Workers **Paid plan** for queues; D1 (SQLite), KV namespace, Workers Queues, Workers AI, and HTMLRewriter for crawling #cloudflare
- [stack] TypeScript 5.8+, Wrangler 4.45+, Vitest 4.1.10 for testing. Main export points to `src/lib.ts` (v1.8.0+); `/worker` export accesses `src/index.ts` #typescript
- [deployment] All resources created via wrangler CLI: `wrangler d1 create seo-agent-db`, `wrangler kv namespace create SEO_OVERRIDES`, `wrangler queues create seo-agent-drafts` #deployment

## Relations
- depends_on [[Core Pipeline Architecture]]
- supports [[Design Principles & Safety]]
