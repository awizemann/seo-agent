---
title: Design Principles & Safety
type: note
permalink: seo-agent/design/design-principles-safety
tags: [design, safety]
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [principle] **Fail-open KV merge** — any KV miss or error in the injector preserves computed meta unchanged. KV problems can never take the site down #safety
- [principle] **Approval-gated changes** — nothing auto-applies unless explicitly opted into `AUTO_APPLY_FIELDS` (empty by default) #control
- [principle] **Environment-driven features** — every feature dormant until its config var or secret exists (GSC, telemetry, citations, etc.). Agent cannot half-configure into broken state #modularity
- [principle] **Async queue isolation** — drafting off request path, isolated to queue consumer, retried independently. Slow/variable model calls don't block the run or exhaust budget #performance
- [principle] **Hard proposal validation** — length windows, complete sentence, no quotes. Invalid drafts dropped and re-enqueued, never applied #validation
- [principle] **Journaled & reversible** — every change tracked and can be undone via reverted KV override #auditability
- [principle] **Deterministic diagnosis** — rules are reproducible, not heuristic. Same input always produces same finding. Findings have open/auto-resolve lifecycle #determinism
- [principle] **Dependencies injected** — pipeline and actions fully deps-injected (v1.8.0+), enabling testability, modularity, and external consumers #architecture

## Relations
- informs [[Core Pipeline Architecture]]
- informs [[Cloudflare Workers Stack]]
- informs [[Configuration via wrangler.jsonc & Secrets]]
