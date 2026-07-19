# seo-agent

A self-contained Cloudflare Worker that keeps a site's SEO healthy and adapts it to
real search traffic. It crawls the site's own sitemap daily, snapshots exactly what
crawlers receive, diagnoses issues with deterministic rules, drafts constrained
meta-copy proposals with Workers AI, and — only after approval — applies them to the
live site instantly through KV overrides. Every change is journaled and reversible.

It also audits the site's **AEO/GEO posture** — whether AI answer engines (ChatGPT,
Claude, Perplexity, Google AI Overviews, Copilot) can crawl it, read it, and cite it:
llms.txt health, robots.txt AI-crawler policy, and whether pages actually serve
content to non-JS AI fetchers. See [AEO / GEO checks](#aeo--geo-checks-ai-answer-engines).

It pairs with an **edge SEO injector** on the site being managed: a Worker in front
of your site that rewrites each page's `<head>` (title, description, canonical,
OpenGraph/Twitter, JSON-LD) and, crucially, merges this agent's KV overrides over
that computed meta. If your site is a Cloudflare Worker you can add the injector as
middleware; for any other origin behind Cloudflare, run it as a proxy Worker on a
route. The one hard requirement is the KV-merge contract in
[Connecting your site](#connecting-your-site-the-injector-side) below — everything
else about your injector is up to you.

## How it works

Daily cron (and `POST /run` on demand):

1. **Crawl** — fetch every sitemap URL, parse the delivered head with HTMLRewriter
   (title, description, canonical, og:image, og:type, JSON-LD types, robots), snapshot
   to D1. The run-over-run diff detects new/removed pages — including pages that appear
   with no deploy (e.g. scheduled content going live at midnight).
2. **Diagnose** — rules produce findings keyed `(path, rule)` with an open/auto-resolve
   lifecycle: injection regressions, missing/short/long descriptions, canonical
   mismatches, sitemap URLs that error or redirect, duplicate titles, missing Article
   JSON-LD, noindex-in-sitemap, long titles, new/removed pages — plus the
   [AEO/GEO checks](#aeo--geo-checks-ai-answer-engines): llms.txt health, robots.txt
   AI-crawler policy, and an AI-user-agent deliverability sample.
3. **Generate** — a run *enqueues* one drafting job per description-quality finding
   (capped at `MAX_PROPOSALS_PER_RUN`) and returns immediately; a **queue consumer**
   drafts them one at a time with Workers AI. Keeping drafting off the request path
   means a slow or variable model call is isolated to its own message (and retried by
   the queue) instead of stalling the run or blowing an invocation budget. Output is
   validated hard (length window, complete sentence, no quotes); invalid drafts are
   dropped and the finding re-enqueues next run.
4. **Act** — approved proposals become KV overrides (`override:<path>` →
   `{"description": "...", "title": "..."}`) that the site's injector merges over its
   computed meta. Live within the injector's KV cache TTL. Nothing auto-applies unless
   a field is opted into `AUTO_APPLY_FIELDS`.
5. **Sense (optional)** — Google Search Console ingestion pulls page+query daily
   metrics (impressions, clicks, CTR, position) into D1 for CTR-outlier detection,
   striking-distance alerts, and before/after measurement of applied changes.

## Setup

Requirements: a Cloudflare account on the **Workers Paid plan** (the drafting queue
requires it), wrangler ≥ 4, Node ≥ 18, and a site that serves a `sitemap.xml` — a plain
`<urlset>`, or a `<sitemapindex>` whose child sitemaps are fetched one level deep — and an
edge injector able to read KV overrides (see [below](#connecting-your-site-the-injector-side)).

```sh
# 1. Clone and install
git clone https://github.com/awizemann/seo-agent && cd seo-agent
npm install

# 2. Create the Cloudflare resources
npx wrangler d1 create seo-agent-db
npx wrangler kv namespace create SEO_OVERRIDES
npx wrangler queues create seo-agent-drafts

# 3. Configure — copy the template and fill in your ids + site profile
cp wrangler.example.jsonc wrangler.jsonc     # gitignored; paste the D1 + KV ids, set SITE_URL etc.
cp .dev.vars.example .dev.vars               # gitignored; used for local dev + type generation

# 4. Apply the database schema
npm run db:init

# 5. Set the control-API token (this gates the API, MCP, and dashboard)
openssl rand -hex 32 | npx wrangler secret put AGENT_TOKEN

# 6. Typecheck + deploy, then trigger the first run
npm run deploy
TOKEN=<the token from step 5>
curl -X POST -H "Authorization: Bearer $TOKEN" https://seo-agent.<your-subdomain>.workers.dev/run
```

Then open `https://seo-agent.<your-subdomain>.workers.dev/` in a browser, paste the
token, and review what it found.

### Set up with a coding agent

Using Claude Code (or any coding agent with shell + wrangler access)? Paste this
prompt, answer its three questions, and a working setup lands in about ten minutes:

```text
Set up https://github.com/awizemann/seo-agent as the SEO/AEO agent for my site.

Ask me these three things before you start (don't guess):
1. SITE_URL — the site to manage. It must serve a sitemap.xml.
2. How the site is fronted: (a) a Cloudflare Worker I can add middleware to, or
   (b) a static/other origin behind Cloudflare — then use the ready-made proxy
   injector in injector/ on a route in front of it.
3. Which optional senses to enable now: Google Search Console (I'd need to
   provide a service-account JSON), AI-traffic telemetry (bind the agent's D1
   into my injector/Worker), citation probes (CITATION_QUERIES plus at least
   one engine key — note Gemini grounding needs a billing-linked Google
   project; unbilled keys get instant 429s).

Then, with wrangler against my Cloudflare account:
1. Clone the repo and npm install.
2. Create the resources: wrangler d1 create seo-agent-db, wrangler kv namespace
   create SEO_OVERRIDES, wrangler queues create seo-agent-drafts.
3. cp wrangler.example.jsonc wrangler.jsonc and fill in the resource ids and my
   site profile (SITE_URL is required; the comments explain every var; leave a
   feature var "" to keep that feature off). cp .dev.vars.example .dev.vars.
4. npm run db:init to apply schema.sql.
5. openssl rand -hex 32, store it with wrangler secret put AGENT_TOKEN, and
   give it to me for the dashboard/MCP.
6. npm run deploy, then POST /run with the bearer and poll /status until the
   first pipeline run completes.
7. Wire the injector side per the README's "Connecting your site": merge the KV
   overrides in my existing Worker, or configure injector/wrangler.jsonc from
   its example and deploy it — ask me before putting anything on a route in
   front of my live site.
8. Verify end-to-end and show me: the /status output, open findings, the
   dashboard URL, and the MCP connect command
   (claude mcp add --transport http seo-agent https://<worker-host>/mcp
    --header "Authorization: Bearer <token>").

Safety rails: never commit wrangler.jsonc, .dev.vars, or any secret; ask before
changing anything that serves my live site; leave AUTO_APPLY_FIELDS empty so
nothing ever changes the site without my approval.
```

The repo is built for this: one config file with annotated vars, idempotent
schema, no migrations, and every feature dormant until its var/secret exists —
an agent can't half-configure it into a broken state.

### Connecting your site (the injector side)

The agent applies changes by writing to KV; your injector reads them. Bind the **same
KV namespace** you created above into your site's injector Worker and merge overrides
over the meta you already compute, per this contract:

- **Key:** `override:<pathname>` — `override:/` for the home page, `override:/blog/x` etc.
- **Value:** a JSON object of overridable fields — `description` and/or `title`.
- **Read** with a short `cacheTtl`, and **fail open**: any KV miss or error must serve
  your computed meta unchanged, so a problem here can never take the site down.

```ts
// In your injector, after computing `meta` for the route:
const raw = await env.SEO_OVERRIDES.get(`override:${pathname || '/'}`, { cacheTtl: 300 });
if (raw) {
  try {
    const o = JSON.parse(raw) as { title?: string; description?: string };
    if (o.title) meta.title = o.title;
    if (o.description) meta.description = o.description;
  } catch { /* fail open — keep computed meta */ }
}
```

**No Worker on your origin?** (a static Pages site, an S3 bucket, any origin behind
Cloudflare you can't add middleware to.) Use the ready-made **proxy injector** in
[`injector/`](injector/) — a standalone Worker you deploy on a route in *front* of
the site. It proxies every request to your origin and merges the same KV overrides
into HTML responses with HTMLRewriter, fail-open, no origin changes. Copy
`injector/wrangler.example.jsonc` → `wrangler.jsonc`, set the route, `ORIGIN_HOST`,
and the shared `SEO_OVERRIDES` namespace, then `wrangler deploy -c injector/wrangler.jsonc`.

## Google Search Console sensing (optional but recommended)

Cloudflare sees traffic after the click; only Search Console knows impressions,
queries, positions, and the clicks that didn't happen — the fuel for CTR optimization
and for measuring whether an applied change worked. Everything still runs on
Cloudflare; GSC is a read-only feed pulled by the Worker.

1. In [Google Cloud Console](https://console.cloud.google.com), create (or pick) a
   project, then **APIs & Services → Library → "Google Search Console API" → Enable**.
2. **IAM & Admin → Service Accounts → Create service account.** Name it (e.g.
   `seo-agent`). No project roles are needed — access is granted in Search Console,
   not IAM.
3. On the new service account: **Keys → Add key → Create new key → JSON.** A key file
   downloads.
4. Copy the service account's email (`seo-agent@<project>.iam.gserviceaccount.com`).
5. In [Search Console](https://search.google.com/search-console): your property →
   **Settings → Users and permissions → Add user** → paste the service-account email →
   permission **Restricted** (enough for Search Analytics reads).
6. Store the key as a Worker secret (never commit it):

   ```sh
   npx wrangler secret put GSC_SERVICE_ACCOUNT_JSON < /path/to/key.json
   ```

Ingestion activates automatically on the next run. `GSC_PROPERTY` must match the
property type — `sc-domain:example.com` for domain properties, the full URL for
URL-prefix properties. Note: GSC data lags ~2 days, and a brand-new property starts
with almost no history.

## AEO / GEO checks (AI answer engines)

Classic SEO gets you ranked; AEO/GEO gets you **cited** — by ChatGPT, Claude,
Perplexity, Google AI Overviews, and Copilot. Three facts drive what this module
checks (all as of 2026):

- **AI crawlers and user-request fetchers do not execute JavaScript.** GPTBot,
  ClaudeBot, PerplexityBot, and the live fetchers (ChatGPT-User, Claude-User,
  Perplexity-User) read raw HTML. A client-rendered SPA that serves an empty shell
  is invisible to them at both index time and answer time, no matter how good its
  `<head>` is.
- **Blocking the wrong bot silently removes you from AI answers.** Answer-engine
  crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot, the user-fetchers —
  plus Googlebot, which feeds AI Overviews/AI Mode, and Bingbot, which grounds
  Copilot) must stay allowed if you want citations. Training-only crawlers
  (GPTBot, ClaudeBot, CCBot, Google-Extended, Applebot-Extended…) are a policy
  choice with **zero** citation cost either way.
- **llms.txt is cheap insurance, not a lever.** Log studies show most llms.txt
  files are never fetched by the big engines — but agent tooling and RAG pipelines
  do use it, it costs almost nothing to serve, and a **soft-404** (a catch-all
  that answers `200` with your HTML shell) is actively worse than a clean 404
  because it feeds agents a misleading non-answer.

The checks run inside every pipeline run (no extra setup, ~6 extra fetches) and
emit findings through the same open/auto-resolve lifecycle as every other rule:

| Rule | Severity | Fires when |
| --- | --- | --- |
| `ai_page_body_empty` | high | A sampled content page serves < 200 chars of visible body text to an AI-bot UA and has no `articleBody` JSON-LD fallback — the page is unreadable/uncitable for AI engines |
| `ai_page_blocked` | high | A sampled page answers 403/429/451 to the AI-bot UA while the plain crawl got 200 — an edge/WAF/bot-management rule is blocking AI crawlers |
| `robots_blocks_ai_bot` | high | robots.txt blocks an answer-engine crawler at `/` — silent removal from that engine's answers |
| `llms_txt_soft_404` | high | `/llms.txt` (or `/llms-full.txt`) answers 200 with HTML — a catch-all shell misleading AI agents |
| `robots_txt_unreachable` | medium | robots.txt is absent or unusable |
| `llms_txt_missing` | medium | No `/llms.txt` |
| `robots_no_ai_policy` | info | robots.txt names no AI crawler — implicit allow-all works, but explicit policy documents intent and survives injected/managed robots.txt defaults |
| `llms_full_txt_missing` | info | `/llms.txt` exists but the optional full-content `/llms-full.txt` doesn't |
| `aeo_check_error` | info | A check couldn't run this pass (transient fetch failure) |

Configuration: `AEO_CHECKS` (default on; `"false"` disables) and `AEO_BOT_UA`
(the UA for the deliverability sample; defaults to a GPTBot user agent). The
sample prefers pages under `ARTICLE_PATH_PREFIX` when set, falls back to all
content pages when none match, and rotates which pages it checks day to day.

### Recommended robots.txt AI policy

If `robots_no_ai_policy` nags you, this is the block it wants — explicit per-bot
groups that document intent and take precedence over any injected or managed
defaults. Keep the answer-engine group allowed; flip the training group to
`Disallow: /` if you don't want your content in training corpora (it costs no
citations):

```txt
# AI answer engines & user-triggered fetchers (citation surfaces)
User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: Claude-SearchBot
User-agent: Claude-User
User-agent: PerplexityBot
User-agent: Perplexity-User
User-agent: Meta-WebIndexer
User-agent: meta-externalfetcher
User-agent: DuckAssistBot
User-agent: MistralAI-User
User-agent: Amazonbot
User-agent: Applebot
Allow: /

# Model-training crawlers (allow or disallow — your policy, zero citation cost)
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: CCBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: meta-externalagent
User-agent: Bytespider
Allow: /

User-agent: *
Allow: /

Sitemap: https://example.com/sitemap.xml
```

Also check your CDN: Cloudflare zones onboarded after mid-2025 default to
**blocking** AI crawlers (Security → Settings → *Bot traffic*, and the AI Crawl
Control dashboard). robots.txt allows mean nothing if the edge 403s the bot —
that's exactly what `ai_page_blocked` catches.

### Serving llms.txt and fixing `ai_page_body_empty`

- **Static sites:** generate `llms.txt` (a markdown index: one `[title](url):
  summary` line per page) and optionally `llms-full.txt` (full corpus) at build
  time, next to your sitemap. On SPA-style hosts with a catch-all, real files are
  also what fixes the soft-404.
- **Worker-fronted sites:** serve both from your data layer in the edge Worker,
  exactly like a sitemap.
- **`ai_page_body_empty` on a CSR SPA** has three fixes, in order of strength:
  server-side/static rendering; an **AI content lane** — your injector detects AI-bot
  UAs and injects the page's full content HTML into the body at the canonical URL
  (leave Googlebot/Bingbot out of the UA list: they render JS and see the real page,
  which also keeps you clear of cloaking concerns; send `Vary: User-Agent`); or, at
  minimum, full text in the Article JSON-LD's `articleBody`, which the check accepts.

```ts
// AI content lane, sketched (in your injector, alongside the KV-override merge):
const AI_BOT_RE = /GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-User|Claude-SearchBot|PerplexityBot|Perplexity-User|meta-external|Meta-WebIndexer|Amazonbot|CCBot|MistralAI-User|DuckAssistBot/i;
if (AI_BOT_RE.test(request.headers.get('user-agent') || '') && contentHtml) {
  rewriter = rewriter.on('div#root', { element: (el) => el.setInnerContent(articleHtml(contentHtml), { html: true }) });
  headers.append('vary', 'User-Agent');
}
```

### Markdown for agents

Agents increasingly negotiate for markdown instead of HTML: they send
`Accept: text/markdown` (possibly alongside `text/html`) and expect
`content-type: text/markdown; charset=utf-8` plus an `x-markdown-tokens`
estimate — the convention Cloudflare's *Markdown for Agents* feature
established. That feature is **Pro plan and up**, and its HTML→markdown
conversion can't help a CSR SPA anyway (converting an empty shell yields
nothing). This project gives you the same behavior on any plan:

- **The proxy injector serves it for free.** Publish a `<path>.md` twin next to
  each page at your origin (e.g. `/eo/some-page.md` beside `/eo/some-page`) —
  for static sites, emit them at build time from the same data as the HTML.
  The injector's **markdown lane** (on by default; `MARKDOWN_LANE: "false"`
  disables) answers any `Accept: text/markdown` GET or HEAD on a clean URL with
  the twin, sending `content-type: text/markdown`, `x-markdown-tokens`,
  `content-signal`, and `Vary: accept`, and falls through to the normal proxy
  when no twin exists.
- **Worker-fronted sites** should negotiate directly: on a content route whose
  `Accept` includes `text/markdown`, return the page as markdown from your data
  layer (and serve the same document at `<path>.md`), with the same three
  headers. Advertise it with
  `<link rel="alternate" type="text/markdown" href="<path>.md">` and a line in
  your `llms.txt`.
- If your policy differs from allow-all, also send a
  [`Content-Signal`](https://contentsignals.org) header that matches your
  robots.txt.

### AI traffic telemetry

Which AI engines actually read your site? GA-style analytics can never tell you —
crawlers don't run JavaScript. The telemetry tap records it at the edge instead:

- **Setup (proxy injector):** bind the agent's D1 database into the injector as
  `TELEMETRY` (see the commented block in `injector/wrangler.example.jsonc`) and
  redeploy. **Worker-fronted sites:** bind the same database (any binding name)
  and insert into `aeo_hits` from your edge handler — copy the injector's
  `tapAeo()` (~30 lines).
- **What's recorded — AI-relevant traffic only:** requests whose UA matches a
  known AI crawler (which bot, path, status, and whether the markdown twin /
  AI content lane / plain HTML was served), human clicks arriving with an AI
  engine Referer (chatgpt.com, perplexity.ai, claude.ai, gemini, copilot, …),
  and markdown-lane responses. Ordinary traffic is never written. Fire-and-forget
  via `waitUntil`, fail-open, pruned after 90 days.
- **Read it:** dashboard cards (AI crawls / AI referrals, 7d), `GET /aeo/hits`,
  the `list_crawler_hits` MCP tool, and two low-noise findings —
  `ai_crawlers_silent` (tap active ≥14 days, zero AI-crawler hits) and
  `ai_crawler_errors` (a bot getting >20% errors on content responses —
  html/lane/md serves only; asset fetches and their 404s don't count).
- Note: Google AI Mode clicks carry `noreferrer` and are invisible to referral
  telemetry everywhere, not just here.

### Citation probes

The outcome metric: do the engines **cite you** for the queries you care about?

- **Configure:** set `CITATION_QUERIES` (a JSON array or `|`-separated list of
  10–30 queries) and at least one engine key. **Cheapest-first:** `GEMINI_API_KEY`
  (Google AI Studio) uses Gemini's Google-Search grounding — note that grounded
  requests require a **billing-linked** Google project (Tier 1; a fresh unbilled
  key gets instant 429s). At weekly probe volume the cost is ≈$0 within the
  monthly grounded allowance. Alternatives: `PERPLEXITY_API_KEY`,
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (~$1–2/month each at this volume, no
  billing-tier dance).
- **Cadence:** probes ride the daily cron once a week (`CITATION_CRON_DAY`,
  default Monday UTC; idempotent per day), or on demand via
  `POST /aeo/citations/run` / the `run_citation_check` MCP tool.
- **Results:** per engine × query — cited or not, rank among the answer's
  sources, and the cited URL — in `GET /aeo/citations`, the `list_citations`
  MCP tool, and a dashboard card. Deltas become findings: `citation_lost`
  (medium — was cited, isn't anymore; stays open until regained) and
  `citation_gained` (info).
- Caveat: engine APIs are a *proxy* for the consumer UIs (different retrieval
  stacks). Track the deltas, not the absolute numbers.

## Review dashboard

A self-contained human UI is served by the Worker itself at **`GET /`** (and
`/dashboard`) — zero dependencies, zero build step, theme-aware, mobile-friendly.
The page is public (it holds no secrets); you paste the `AGENT_TOKEN` once and it
is kept in `localStorage` and sent as the bearer on every API call. From it you
can: see status cards (pending / open findings / applied / GSC freshness), review
pending proposals with a strikethrough-current-vs-proposed diff and approve or
reject each, trigger a pipeline run, draft a description on demand (dry run) and
promote it to a proposal, browse open findings, and revert any applied change
from the journal. It's the fastest way to clear the daily batch — open the URL,
review, tap approve.

## MCP control surface

The same actions are exposed as a **stateless MCP server** at `/mcp` (Streamable
HTTP: single JSON responses, 202 for notifications, 405 on GET, Origin-validated,
no SSE/sessions, zero dependencies). Connect from Claude Code:

```sh
claude mcp add --transport http seo-agent https://<worker-host>/mcp \
  --header "Authorization: Bearer <AGENT_TOKEN>"
```

Any Claude session can then drive the agent conversationally — "what did the SEO
agent find overnight?", "approve proposal 7", "draft me three alternatives for
/press", "which AI bots crawled us this week?" — via the tools: `seo_status`,
`run_pipeline`, `list_findings`, `list_proposals`, `approve_proposal`,
`reject_proposal`, `create_proposal`, `dry_run_draft`, `list_changes`,
`revert_change`, `list_overrides`, `list_crawler_hits`, `list_citations`,
`run_citation_check`.

## Control API

All endpoints require `Authorization: Bearer <AGENT_TOKEN>` (the MCP endpoint too).

| Endpoint | What it does |
| --- | --- |
| `GET /status` | Last run, open findings by severity, proposals by status, change counts, GSC freshness |
| `POST /run` | Run the full pipeline now |
| `GET /findings?status=open` | Findings (default open) |
| `GET /proposals?status=proposed` | Proposals (default awaiting review) |
| `POST /proposals` `{"path", "value", "field"?, "rationale"?}` | Create a manual proposal (e.g. promote a dry-run winner); same validation and approval gate |
| `POST /proposals/:id/approve` | Apply to the live site via KV override (journaled) |
| `POST /proposals/:id/reject` | Reject a proposal |
| `POST /proposals/dry-run` `{"path": "/x"}` | Draft for one page; returns raw model output + validation verdicts; persists nothing |
| `GET /changes` | The apply/revert journal |
| `POST /changes/:id/revert` | Remove an override; the site falls back to its baked value; retires the source proposal |
| `GET /overrides` | Current live override state from KV |
| `GET /aeo/hits?days=7` | AI-traffic telemetry: crawler fetches, AI referrals, markdown-lane responses |
| `GET /aeo/citations` | Citation-probe results (engine × query: cited, rank, cited URL), newest first |
| `POST /aeo/citations/run` | Probe all configured engines with every citation query now |

## Configuration

All vars live in `wrangler.jsonc`; secrets are set with `wrangler secret put`. Only
`SITE_URL` and the `AGENT_TOKEN` secret are required — everything else has a sensible
default or is optional. See `wrangler.example.jsonc` for the annotated template.

| Var / secret | Required | Meaning |
| --- | --- | --- |
| `SITE_URL` (var) | ✓ | Origin to crawl and manage |
| `AGENT_TOKEN` (secret) | ✓ | Bearer token gating the API, MCP endpoint, and dashboard |
| `SITE_NAME` (var) | | Brand/site name for the AI prompt (defaults to the hostname) |
| `SITE_DESCRIPTION` (var) | | One clause describing the site, woven into the drafting prompt |
| `AI_MODEL` (var) | | Workers AI text model for proposals |
| `AUTO_APPLY_FIELDS` (var) | | Fields that may apply without approval; empty = approval required |
| `MAX_PROPOSALS_PER_RUN` (var) | | Cap on AI drafts per run |
| `TITLE_BRAND_SUFFIX` (var) | | Brand suffix your injector appends to titles; `""` disables the suffix rules |
| `SHELL_TITLE` (var) | | Your SPA shell's static `<title>`; `""` disables the injection-regression check |
| `ARTICLE_PATH_PREFIX` (var) | | Content detail-page prefix (e.g. `/articles/`); enables the Article-JSON-LD check + enrichment |
| `ARTICLE_API_TEMPLATE` (var) | | JSON endpoint with `{slug}` returning `{excerpt?, content?}` for richer drafting |
| `AEO_CHECKS` (var) | | AEO/GEO checks (llms.txt, robots AI policy, AI-UA sampling); on by default, `"false"` disables |
| `AEO_BOT_UA` (var) | | User agent for the AI deliverability sample; empty = a GPTBot UA |
| `GSC_PROPERTY` (var) | | Search Console property id (`sc-domain:…` or URL) |
| `GSC_SERVICE_ACCOUNT_JSON` (secret) | | Google service-account key; GSC sensing is dormant without it |
| `CITATION_QUERIES` (var) | | Queries for the citation probes (JSON array or `\|`-separated); empty = probes off |
| `CITATION_CRON_DAY` (var) | | UTC weekday (0–6) the weekly probes run on; default `1` (Monday) |
| `GEMINI_API_KEY` (secret) | | Citation probes via Gemini Google-Search grounding — the free-tier default engine |
| `PERPLEXITY_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (secrets) | | Optional additional citation engines (each ~$1–2/mo at weekly cadence) |

## Safety model

- **Approval-gated by default** — the agent proposes; a human (or an explicitly
  configured auto-apply field) disposes.
- **Journaled** — every apply and revert lands in `changes` with old/new values.
- **Reversible** — one call restores the baked value; the source proposal is retired
  so the page becomes proposable again.
- **Fail-open injector contract** — a broken agent or KV can never take the site down.
- **Validated AI output** — length/sentence rules enforced post-generation; invalid
  drafts are dropped, never shipped.

## Operating notes

- Schedule the cron just after your content goes live (the default is 06:17 UTC, chosen
  for a site whose content publishes at UTC midnight). Cron times are UTC.
- Worker deploys propagate over ~1–2 minutes; immediately after `npm run deploy`, requests
  can hit the previous version. Poll before diagnosing.
- Upgrading an existing install: re-run `npm run db:init` after pulling a new version. It's
  idempotent (every table is `CREATE TABLE IF NOT EXISTS`) and adds any tables a newer
  version introduced (e.g. `aeo_hits`, `citations`), so `/status` doesn't error on a
  database that predates them.
- Reasoning models (e.g. GLM-4.7-Flash) spend tokens thinking before answering — keep
  `max_tokens` generous (the code uses 2048) or `content` comes back empty.
- Cost at 150 URLs/day: ~150 subrequests + ≤8 small AI drafts — effectively pennies
  per month on Workers paid.
