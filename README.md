# seo-agent

A self-contained Cloudflare Worker that keeps a site's SEO healthy and adapts it to
real search traffic. It crawls the site's own sitemap daily, snapshots exactly what
crawlers receive, diagnoses issues with deterministic rules, drafts constrained
meta-copy proposals with Workers AI, and — only after approval — applies them to the
live site instantly through KV overrides. Every change is journaled and reversible.

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
   JSON-LD, noindex-in-sitemap, long titles, new/removed pages.
3. **Generate** — description-quality findings feed Workers AI. Output is validated
   hard (length window, complete sentence, no quotes), retried once with feedback,
   dropped if still invalid. Capped per run (`MAX_PROPOSALS_PER_RUN`).
4. **Act** — approved proposals become KV overrides (`override:<path>` →
   `{"description": "...", "title": "..."}`) that the site's injector merges over its
   computed meta. Live within the injector's KV cache TTL. Nothing auto-applies unless
   a field is opted into `AUTO_APPLY_FIELDS`.
5. **Sense (optional)** — Google Search Console ingestion pulls page+query daily
   metrics (impressions, clicks, CTR, position) into D1 for CTR-outlier detection,
   striking-distance alerts, and before/after measurement of applied changes.

## Setup

Requirements: a Cloudflare account with Workers (paid plan recommended), wrangler ≥ 4,
Node ≥ 18, and a site that serves a `sitemap.xml` and has an edge injector able to read
KV overrides (see [below](#connecting-your-site-the-injector-side)).

```sh
# 1. Clone and install
git clone https://github.com/awizemann/seo-agent && cd seo-agent
npm install

# 2. Create the Cloudflare resources
npx wrangler d1 create seo-agent-db
npx wrangler kv namespace create SEO_OVERRIDES

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
/press" — via the tools: `seo_status`, `run_pipeline`, `list_findings`,
`list_proposals`, `approve_proposal`, `reject_proposal`, `create_proposal`,
`dry_run_draft`, `list_changes`, `revert_change`, `list_overrides`.

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
| `GSC_PROPERTY` (var) | | Search Console property id (`sc-domain:…` or URL) |
| `GSC_SERVICE_ACCOUNT_JSON` (secret) | | Google service-account key; GSC sensing is dormant without it |

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
- Reasoning models (e.g. GLM-4.7-Flash) spend tokens thinking before answering — keep
  `max_tokens` generous (the code uses 2048) or `content` comes back empty.
- Cost at 150 URLs/day: ~150 subrequests + ≤8 small AI drafts — effectively pennies
  per month on Workers paid.
