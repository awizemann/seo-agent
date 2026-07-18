/**
 * Site profile — every adopter-specific value, read from wrangler vars with
 * generic fallbacks so the agent runs against ANY site with zero code edits.
 * Set these in wrangler.jsonc `vars` (see wrangler.example.jsonc). Only SITE_URL
 * is required; the rest tune behavior and default to safe generic values.
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
};

export function siteConfig(env: Env): SiteConfig {
  const host = new URL(env.SITE_URL).hostname;
  // Optional-cast so upgraded deployments whose wrangler.jsonc predates these
  // vars still typecheck (wrangler types only emits vars present in the config).
  const e = env as Env & { AEO_CHECKS?: string; AEO_BOT_UA?: string };
  return {
    siteUrl: env.SITE_URL,
    siteName: env.SITE_NAME || host,
    siteDescription: env.SITE_DESCRIPTION || `the website at ${host}`,
    titleBrandSuffix: env.TITLE_BRAND_SUFFIX || '',
    shellTitle: env.SHELL_TITLE || '',
    articlePathPrefix: env.ARTICLE_PATH_PREFIX || '',
    articleApiTemplate: env.ARTICLE_API_TEMPLATE || '',
    aeoChecks: !/^(false|0|off)$/i.test(e.AEO_CHECKS ?? ''),
    aeoBotUa:
      e.AEO_BOT_UA ||
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  };
}
