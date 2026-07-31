/**
 * Site profile — every adopter-specific value, read from wrangler vars with
 * generic fallbacks so the agent runs against ANY site with zero code edits.
 * Set these in wrangler.jsonc `vars` (see wrangler.example.jsonc). Only SITE_URL
 * is required; the rest tune behavior and default to safe generic values.
 *
 * The resolution itself is PURE DATA (resolveSiteConfig): it takes a plain
 * record of var names, not the Worker Env, so a multi-tenant host can hydrate a
 * site profile from a database row. siteConfigFromEnv is the Worker adapter.
 * SECRETS (API keys, the service-account JSON, AGENT_TOKEN) deliberately never
 * enter SiteConfig — they stay on Env and are read at their point of use.
 */
export type SiteConfig = {
  siteUrl: string;
  siteName: string;
  /** One clause describing the site, woven into the AI drafting prompt. */
  siteDescription: string;
  /** Brand suffix the injector appends to titles, e.g. " | Acme". "" disables the suffix-aware title rules. */
  titleBrandSuffix: string;
  /** The static SPA-shell <title>. "" disables the injection-regression check. */
  shellTitle: string;
  /** Content detail-page path prefix, e.g. "/articles/". "" disables the Article-JSON-LD check and body enrichment. */
  articlePathPrefix: string;
  /** JSON endpoint template with {slug} returning {excerpt?, content?} for richer drafting context. "" disables enrichment. */
  articleApiTemplate: string;
  /** AEO/GEO checks (llms.txt, robots AI policy, AI-UA deliverability sampling). On by default; "false"/"0"/"off" disables. */
  aeoChecks: boolean;
  /** User agent for the AI deliverability sample fetches (defaults to a GPTBot UA). */
  aeoBotUa: string;
  /** Workers AI model id used for drafting. */
  aiModel: string;
  /** Per-run cap on drafting jobs enqueued; 0 (or unparseable) disables proposing. */
  maxProposalsPerRun: number;
  /** Fields applied without approval, parsed from the comma-separated var. [] = approval required. */
  autoApplyFields: string[];
  /** Search Console property (e.g. "sc-domain:example.com"). "" when GSC is not configured. */
  gscProperty: string;
  /** Max sitemap URLs crawled per run, clamped to [1, 2000]. Unset/invalid = 2000 (the historical cap). */
  pageCap: number;
  /** Citation-probe settings; engine enablement stays key-derived in citations.ts. */
  citations: {
    queries: string[];
    /** UTC weekday 0 (Sun) – 6 (Sat) the weekly probe runs on. Defaults to Monday. */
    cronDay: number;
    geminiModel: string;
    perplexityModel: string;
    openaiModel: string;
    anthropicModel: string;
  };
};

/** CITATION_QUERIES accepts a JSON array or |- / newline-separated text. */
export function parseQueries(raw: string): string[] {
  const t = (raw || '').trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const a = JSON.parse(t);
      if (Array.isArray(a)) return a.map(String).map((s) => s.trim()).filter(Boolean);
    } catch {
      // fall through to separator parsing
    }
  }
  return t.split(/\||\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * CITATION_CRON_DAY is a UTC weekday 0 (Sun) – 6 (Sat). Anything out of range or
 * non-numeric — e.g. "7", which getUTCDay() never returns, silently disabling
 * probes forever — falls back to Monday (1). Exported for tests.
 */
export function clampCronDay(raw: string | undefined): number {
  const d = parseInt(raw ?? '', 10);
  return Number.isInteger(d) && d >= 0 && d <= 6 ? d : 1;
}

/** Resolve a site profile from a plain var record. Pure — no Env, no I/O. */
export function resolveSiteConfig(vars: Record<string, string | undefined>): SiteConfig {
  const siteUrl = vars.SITE_URL ?? '';
  let host: string;
  try {
    host = new URL(siteUrl).hostname;
  } catch {
    throw new Error(`SITE_URL missing or invalid: "${siteUrl}"`);
  }
  return {
    siteUrl,
    siteName: vars.SITE_NAME || host,
    siteDescription: vars.SITE_DESCRIPTION || `the website at ${host}`,
    titleBrandSuffix: vars.TITLE_BRAND_SUFFIX || '',
    shellTitle: vars.SHELL_TITLE || '',
    articlePathPrefix: vars.ARTICLE_PATH_PREFIX || '',
    articleApiTemplate: vars.ARTICLE_API_TEMPLATE || '',
    aeoChecks: !/^(false|0|off)$/i.test(vars.AEO_CHECKS ?? ''),
    // The trailing "seo-agent-sample" marker lets telemetry taps ignore the
    // agent's own deliverability probes (they'd otherwise count as GPTBot).
    aeoBotUa:
      vars.AEO_BOT_UA ||
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot; seo-agent-sample',
    aiModel: vars.AI_MODEL || '',
    maxProposalsPerRun: Math.max(0, parseInt(vars.MAX_PROPOSALS_PER_RUN ?? '', 10) || 0),
    autoApplyFields: (vars.AUTO_APPLY_FIELDS || '').split(',').map((f) => f.trim()).filter(Boolean),
    gscProperty: vars.GSC_PROPERTY || '',
    pageCap: (() => {
      const n = parseInt(vars.PAGE_CAP ?? '', 10);
      return Number.isInteger(n) && n > 0 ? Math.min(n, 2000) : 2000;
    })(),
    citations: {
      queries: parseQueries(vars.CITATION_QUERIES ?? ''),
      cronDay: clampCronDay(vars.CITATION_CRON_DAY),
      geminiModel: vars.CITATION_GEMINI_MODEL || 'gemini-flash-latest',
      perplexityModel: vars.CITATION_PERPLEXITY_MODEL || 'sonar',
      openaiModel: vars.CITATION_OPENAI_MODEL || 'gpt-5-mini',
      anthropicModel: vars.CITATION_ANTHROPIC_MODEL || 'claude-sonnet-5',
    },
  };
}

/**
 * The vars the Worker adapter reads — STRUCTURAL, deliberately not the
 * wrangler-generated `Env` global, so library consumers can call the adapters
 * without that ambient type existing in their project. Everything is optional
 * except SITE_URL (matching resolveSiteConfig's one hard requirement), which
 * also keeps deployments whose wrangler.jsonc predates a var typechecking.
 */
export type SiteVarEnv = {
  SITE_URL: string;
  SITE_NAME?: string;
  SITE_DESCRIPTION?: string;
  TITLE_BRAND_SUFFIX?: string;
  SHELL_TITLE?: string;
  ARTICLE_PATH_PREFIX?: string;
  ARTICLE_API_TEMPLATE?: string;
  AEO_CHECKS?: string;
  AEO_BOT_UA?: string;
  AI_MODEL?: string;
  MAX_PROPOSALS_PER_RUN?: string;
  AUTO_APPLY_FIELDS?: string;
  GSC_PROPERTY?: string;
  PAGE_CAP?: string;
  CITATION_QUERIES?: string;
  CITATION_CRON_DAY?: string;
  CITATION_GEMINI_MODEL?: string;
  CITATION_PERPLEXITY_MODEL?: string;
  CITATION_OPENAI_MODEL?: string;
  CITATION_ANTHROPIC_MODEL?: string;
};

/** Worker adapter: map Env vars into the plain record resolveSiteConfig wants. */
export function siteConfigFromEnv(e: SiteVarEnv): SiteConfig {
  return resolveSiteConfig({
    SITE_URL: e.SITE_URL,
    SITE_NAME: e.SITE_NAME,
    SITE_DESCRIPTION: e.SITE_DESCRIPTION,
    TITLE_BRAND_SUFFIX: e.TITLE_BRAND_SUFFIX,
    SHELL_TITLE: e.SHELL_TITLE,
    ARTICLE_PATH_PREFIX: e.ARTICLE_PATH_PREFIX,
    ARTICLE_API_TEMPLATE: e.ARTICLE_API_TEMPLATE,
    AEO_CHECKS: e.AEO_CHECKS,
    AEO_BOT_UA: e.AEO_BOT_UA,
    AI_MODEL: e.AI_MODEL,
    MAX_PROPOSALS_PER_RUN: e.MAX_PROPOSALS_PER_RUN,
    AUTO_APPLY_FIELDS: e.AUTO_APPLY_FIELDS,
    GSC_PROPERTY: e.GSC_PROPERTY,
    PAGE_CAP: e.PAGE_CAP,
    CITATION_QUERIES: e.CITATION_QUERIES,
    CITATION_CRON_DAY: e.CITATION_CRON_DAY,
    CITATION_GEMINI_MODEL: e.CITATION_GEMINI_MODEL,
    CITATION_PERPLEXITY_MODEL: e.CITATION_PERPLEXITY_MODEL,
    CITATION_OPENAI_MODEL: e.CITATION_OPENAI_MODEL,
    CITATION_ANTHROPIC_MODEL: e.CITATION_ANTHROPIC_MODEL,
  });
}
