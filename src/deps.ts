/**
 * The agent's dependency object — everything the pipeline needs, as DATA rather
 * than as the Worker `Env`. Modules take `AgentDeps` (or an explicit narrow
 * slice of it) so a future host can hand them a D1-over-HTTP `db` and a site
 * profile loaded from a database row instead of wrangler vars.
 *
 * SECRETS live here, on `secrets`, deliberately NOT on SiteConfig: config is
 * data a multi-tenant host may store and render; secrets are not (see the note
 * at the top of config.ts).
 *
 * There is no separate telemetry binding: the site's edge Worker binds THIS
 * agent's D1 as its own `TELEMETRY` and writes `aeo_hits` rows into it, so on
 * the agent side telemetry is just `deps.db`.
 */

import type { SiteConfig, SiteVarEnv } from './config.js';
import { siteConfigFromEnv } from './config.js';
import type { DraftJob } from './propose.js';

/** Optional API credentials. Absent/empty = that capability stays dormant. */
export type AgentSecrets = {
  /** Google service-account JSON; absent disables GSC ingest and the impact sense. */
  gscServiceAccountJson?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  perplexityApiKey?: string;
  anthropicApiKey?: string;
};

export type AgentDeps = {
  db: D1Database;
  overrides: KVNamespace;
  draftQueue: Queue<DraftJob>;
  ai: Ai;
  config: SiteConfig;
  secrets: AgentSecrets;
  /**
   * ORIGIN READS ONLY — HOW a fetch of the site's OWN bytes travels. Absent
   * (the self-hoster's case, and every host with no reason to care) it is the
   * global `fetch` and nothing changes anywhere.
   *
   * WHY IT IS A PORT AND NOT A URL: `SiteConfig.originFetchBase` answers WHERE
   * an origin read goes; this answers HOW it gets there, and on Cloudflare
   * those are genuinely two questions. A Worker subrequest to ANY hostname
   * attached to its own zone skips Workers routes AND custom domains and
   * connects to the placeholder DNS record — 522 — so a host whose origin is
   * ITSELF cannot reach it over the network at all, however correct the URL
   * is. It has to dispatch in-runtime (a service binding pointed at itself).
   * The library cannot know any of that; it can only be handed a fetcher.
   *
   * CONTRACT: fetch-compatible, and used ONLY for reads of the site's own
   * origin. Vetting what it may connect to is the caller's job, exactly as
   * with originFetchBase — the library has no SSRF guard of its own, and
   * deliberately should not (a self-hoster crawls their own site).
   */
  originFetch?: typeof fetch;
};

/**
 * The bindings + vars + secrets the Worker adapter reads — STRUCTURAL, not the
 * wrangler-generated `Env` global, so library consumers don't need that ambient
 * type. Secrets are optional because `wrangler types` only emits secrets
 * present in the deployment, and every engine key is independently optional.
 */
export type WorkerEnv = SiteVarEnv & {
  DB: D1Database;
  OVERRIDES: KVNamespace;
  DRAFT_QUEUE: Queue;
  AI: Ai;
  GSC_SERVICE_ACCOUNT_JSON?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
};

/** Worker adapter: map bindings, vars and secrets into AgentDeps. */
export function depsFromEnv(e: WorkerEnv): AgentDeps {
  return {
    db: e.DB,
    overrides: e.OVERRIDES,
    draftQueue: e.DRAFT_QUEUE as Queue<DraftJob>,
    ai: e.AI,
    config: siteConfigFromEnv(e),
    secrets: {
      gscServiceAccountJson: e.GSC_SERVICE_ACCOUNT_JSON,
      openaiApiKey: e.OPENAI_API_KEY,
      geminiApiKey: e.GEMINI_API_KEY,
      perplexityApiKey: e.PERPLEXITY_API_KEY,
      anthropicApiKey: e.ANTHROPIC_API_KEY,
    },
  };
}
