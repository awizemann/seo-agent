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
};

export function siteConfig(env: Env): SiteConfig {
  const host = new URL(env.SITE_URL).hostname;
  return {
    siteUrl: env.SITE_URL,
    siteName: env.SITE_NAME || host,
    siteDescription: env.SITE_DESCRIPTION || `the website at ${host}`,
    titleBrandSuffix: env.TITLE_BRAND_SUFFIX || '',
    shellTitle: env.SHELL_TITLE || '',
    articlePathPrefix: env.ARTICLE_PATH_PREFIX || '',
    articleApiTemplate: env.ARTICLE_API_TEMPLATE || '',
  };
}
