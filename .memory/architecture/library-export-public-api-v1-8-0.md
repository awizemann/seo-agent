---
title: Library Export & Public API (v1.8.0)
type: note
permalink: seo-agent/architecture/library-export-public-api-v1-8-0
tags: [library, api, exports]
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [change] v1.8.0 introduces public library surface via `src/lib.ts` (exported as `.` and `./lib` from package.json exports) #release
- [exports] Main export (`.`): `src/lib.ts` (types + default). `/worker` export: `src/index.ts` (Worker itself). `/lib` export: `src/lib.ts` (alias) #api
- [design] Dependencies fully injected (pipeline, actions), enabling external consumers to build against the library and provide their own sensing/diagnosis modules #modularity
- [history] v1.7.x was worker-only. Library extraction recent (cd64ffc v1.8.0, 37f9703 audit fixes, f7447f6 public entry point) #history

## Relations
- implements [[Design Principles & Safety]]

- [fact] v1.9.0 (2026-07-31): `SiteConfig.pageCap` (PAGE_CAP var, clamped [1, 2000], default 2000) is enforced in runCrawl — hosts cap per-run crawl size via config, not queue-message convention. #config
- [fact] v1.9.0: `siteConfigFromEnv`/`depsFromEnv` take structural `SiteVarEnv`/`WorkerEnv` (both exported from lib.ts) instead of the wrangler-generated `Env` global — library consumers need no `Env = any` shim. #api
