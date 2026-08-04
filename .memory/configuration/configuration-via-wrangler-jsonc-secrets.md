---
title: Configuration via wrangler.jsonc & Secrets
type: note
permalink: seo-agent/configuration/configuration-via-wrangler-jsonc-secrets
tags: [configuration, wrangler, secrets]
source_paths: [wrangler.example.jsonc]
source_paths_inferred: false
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [primary] Primary config file: `wrangler.jsonc` (gitignored, template at `wrangler.example.jsonc` with full annotation) #config-file
- [required] `SITE_URL` (site to manage, must serve sitemap.xml), resource IDs (D1 `database_id`, KV `namespaces.id` for SEO_OVERRIDES, Queues `queue_name` for seo-agent-drafts) bound at deploy time #required
- [optional] Optional feature flags: `GSC_PROPERTY`, `CITATION_QUERIES`, `AEO_CHECKS` (default on), `ARTICLE_PATH_PREFIX`, `MARKDOWN_LANE` (default on), `AUTO_APPLY_FIELDS` (default empty), engine keys (`GEMINI_API_KEY`, etc.) #optional
- [principle] Features are **dormant until configured** — missing var/secret = feature off, no error. Agent cannot break itself via incomplete config #principle
- [secrets] `AGENT_TOKEN` (required, gates API/MCP/dashboard, generated once via `wrangler secret put AGENT_TOKEN`, never in config file). Optional: `GSC_SERVICE_ACCOUNT_JSON`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (one required per citation engine, if enabled) #secrets
- [dev] `.dev.vars.example` → `.dev.vars` (gitignored, used for local dev + type generation via `wrangler types`) #dev
- [schema] Idempotent schema (schema.sql applied via `npm run db:init`); no migrations, safe to re-run #schema

## Relations
- implements [[Design Principles & Safety]]
- depends_on [[Cloudflare Workers Stack]]
