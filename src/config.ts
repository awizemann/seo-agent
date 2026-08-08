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
  /**
   * ORIGIN READS ONLY — the base a fetch of the site's OWN bytes goes to when
   * that is not the public site URL. Unset (the self-hoster's case, and every
   * site not fronted by a proxy) it does not exist and everything reads
   * `siteUrl` exactly as it always did.
   *
   * WHY IT EXISTS: when the site is fronted by a proxy WE run, a subrequest to
   * the public hostname can never reach the origin — on Cloudflare a Worker
   * subrequest to its own zone's route-attached hostname skips Workers routes
   * entirely and lands on whatever DNS says, which for a proxied site is a
   * placeholder (522). The origin host answers directly, and it is the same
   * truth `x-seo-agent-bypass` was reaching for, minus the round trip.
   *
   * WHAT IT IS NOT: it is NEVER a source of EMITTED urls. Canonicals,
   * expectedCanonicalUrl, sitemap `<loc>`s and llms.txt links are all public
   * addresses and keep coming from `siteUrl`; an origin host in any of them
   * would publish an address no visitor can use. Read `originReadOrigin(cfg)`
   * at a fetch, `cfg.siteUrl` everywhere else.
   *
   * The host behind it is the CALLER's to vet — the library deliberately has no
   * SSRF guard of its own (a self-hoster crawls their own site); a multi-tenant
   * host must gate this host exactly as strictly as it gates the site host.
   */
  originFetchBase?: string;
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
  /**
   * Freeform POSITIVE-form drafting guidance, woven into the AI prompt as its
   * own paragraph after the site description — "Refer to the company as Acme.
   * Write 'partner' where you would write 'client'." "" leaves the prompt
   * exactly as it was. Say what you WANT written; the prohibitions belong in
   * bannedTerms, which is checked deterministically rather than asked for.
   */
  draftingGuidance: string;
  /**
   * Words/phrases a draft must not contain. Checked AFTER generation
   * (case-insensitive, on word boundaries) rather than only asked for in the
   * prompt — a model told "never say X" still says X. A hit makes the draft
   * invalid, which feeds the existing one-retry-with-reason loop. Keep the
   * list tight: long constraint lists measurably degrade the writing.
   */
  bannedTerms: string[];
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
 * BANNED_TERMS accepts a JSON array or comma- / newline-separated text — the
 * same two-shape tolerance as CITATION_QUERIES, with the comma as the separator
 * because a banned term is a word or short phrase, not a sentence containing
 * commas. Duplicates and casing are irrelevant to the matcher, so neither is
 * normalized away here; empty entries are dropped.
 */
export function parseTerms(raw: string): string[] {
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
  return t.split(/,|\n/).map((s) => s.trim()).filter(Boolean);
}

// Characters that would otherwise make a user-supplied term a regex of its own.
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * The first banned term appearing in `text`, or null. Case-insensitive and
 * boundary-anchored, so banning "AI" does not flag "maintain".
 *
 * The boundary is chosen per side: \b only exists between a word and a
 * non-word character, so a term like "C++" (ending in punctuation) would never
 * match with a trailing \b. Terms starting/ending in a word character get \b;
 * the other sides get a "not adjacent to a word character" lookaround.
 *
 * KNOWN LIMIT: JavaScript's \w — and therefore \b — is ASCII-only. A term with
 * diacritics or non-Latin script ("café", "北京") still matches as a substring,
 * but its boundary check degrades: "café" is not flagged inside "cafés" the way
 * an ASCII term would be, because é already counts as a non-word character.
 * Unicode-property boundaries would fix this at the cost of a far subtler
 * regex; for a vocabulary list of brand and competitor names this is the honest
 * trade, not a silent one.
 */
export function findBannedTerm(text: string, terms: string[] | undefined): string | null {
  if (!text || !terms || terms.length === 0) return null;
  for (const raw of terms) {
    const term = (raw ?? '').trim();
    if (!term) continue;
    const left = /^\w/.test(term) ? '\\b' : '(?<!\\w)';
    const right = /\w$/.test(term) ? '\\b' : '(?!\\w)';
    // The escape makes construction safe for every practical term; the catch is
    // a backstop so one exotic entry can never throw a crawl or a draft away.
    let re: RegExp;
    try {
      re = new RegExp(left + term.replace(REGEX_META, '\\$&') + right, 'i');
    } catch {
      continue;
    }
    if (re.test(text)) return term;
  }
  return null;
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

/**
 * ORIGIN_FETCH_BASE, reduced to a bare origin — or undefined.
 *
 * FAIL-CLOSED means FALL BACK HERE, not throw: the fallback is `siteUrl`, which
 * is the behaviour every site had before this var existed and the one the
 * caller's guards already cover. A malformed value must never take robots.txt
 * generation off the air for a site that was fine without it.
 *
 * Only http(s), and only an ORIGIN: any path, query, fragment, username or
 * password is dropped rather than honoured, so nothing downstream can smuggle a
 * path prefix into a URL a caller believes it built itself.
 */
export function parseOriginFetchBase(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim();
  if (!t) return undefined;
  try {
    const u = new URL(t);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    if (u.username || u.password) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/**
 * The origin an ORIGIN READ fetches from: the override when one is configured,
 * the site's own origin otherwise. Every fetch that reads the site's own bytes
 * goes through this; nothing that EMITS a url does. See SiteConfig.originFetchBase.
 */
export function originReadOrigin(cfg: Pick<SiteConfig, 'siteUrl' | 'originFetchBase'>): string {
  return cfg.originFetchBase || new URL(cfg.siteUrl).origin;
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
  const originFetchBase = parseOriginFetchBase(vars.ORIGIN_FETCH_BASE);
  return {
    siteUrl,
    // Spread-or-nothing: an unset override leaves the key ABSENT rather than
    // present-and-undefined, so `'originFetchBase' in cfg` stays honest.
    ...(originFetchBase ? { originFetchBase } : {}),
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
    draftingGuidance: (vars.DRAFTING_GUIDANCE || '').trim(),
    bannedTerms: parseTerms(vars.BANNED_TERMS ?? ''),
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
  ORIGIN_FETCH_BASE?: string;
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
  DRAFTING_GUIDANCE?: string;
  BANNED_TERMS?: string;
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
    ORIGIN_FETCH_BASE: e.ORIGIN_FETCH_BASE,
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
    DRAFTING_GUIDANCE: e.DRAFTING_GUIDANCE,
    BANNED_TERMS: e.BANNED_TERMS,
    PAGE_CAP: e.PAGE_CAP,
    CITATION_QUERIES: e.CITATION_QUERIES,
    CITATION_CRON_DAY: e.CITATION_CRON_DAY,
    CITATION_GEMINI_MODEL: e.CITATION_GEMINI_MODEL,
    CITATION_PERPLEXITY_MODEL: e.CITATION_PERPLEXITY_MODEL,
    CITATION_OPENAI_MODEL: e.CITATION_OPENAI_MODEL,
    CITATION_ANTHROPIC_MODEL: e.CITATION_ANTHROPIC_MODEL,
  });
}
