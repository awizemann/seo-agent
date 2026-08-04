---
title: Markdown for Agents Support
type: note
permalink: seo-agent/features/markdown-for-agents-support
tags: [markdown, agents, aeo]
source_sha: cd64ffc7364e0bc15b64e905344c77849b71f24a
created: 2026-07-31
updated: 2026-07-31
reviewed: 2026-07-31
reviewed_by: audit:claude-haiku-4-5
---

## Observations
- [context] Agents increasingly send `Accept: text/markdown`; Cloudflare's **Markdown for Agents** (Pro plan+) provides HTML→markdown conversion (won't help CSR SPAs). This project provides markdown support on any plan #context
- [proxy_injector] Proxy injector serves markdown for free: if `<path>.md` twin exists at origin, answers `Accept: text/markdown` GET/HEAD with the twin, sending `content-type: text/markdown`, `x-markdown-tokens`, `content-signal`, `Vary: accept`. Falls through to normal proxy if no twin #implementation
- [config] `MARKDOWN_LANE: "false"` disables (default on) #configuration
- [static_sites] Emit `<path>.md` twins at build time alongside HTML, from the same data #static-sites
- [worker_sites] Negotiate directly: on markdown Accept, return markdown from data layer, send `content-type`, `x-markdown-tokens`, `content-signal` headers. Advertise with `<link rel="alternate" type="text/markdown" href="<path>.md">` and llms.txt line #worker-sites
- [policy] If content policy differs from allow-all, send `Content-Signal` header matching robots.txt intent #best-practice

## Relations
- part_of [[AEO/GEO Checks & AI Answer Engines]]
- depends_on [[Cloudflare Workers Stack]]
