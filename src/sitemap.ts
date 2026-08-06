/**
 * /sitemap.xml generation — the page list for a site that doesn't have one.
 *
 * The crawler already falls back to a bounded homepage link-crawl when a site
 * has no usable sitemap (crawl.ts), and says so as the `sitemap_missing`
 * finding. This module closes that loop: it turns the crawl the agent already
 * did into the file the site was missing, published through the ordinary
 * review lane — a proposal on the `sitemap_xml` field, approved by a human,
 * applied to KV as a resource override (RESOURCE_FIELDS in overrides.ts) and
 * revertable from the same journal as any other change. Nothing here writes to
 * KV directly.
 *
 * THREE RULES THIS FILE EXISTS TO KEEP:
 *
 * 1. ORIGIN WINS. We only ever offer this when the site's own sitemap could not
 *    serve — which is exactly the condition `sitemap_missing` records. A site
 *    with a working sitemap keeps it; see `sitemapProposalBlockedReason`.
 * 2. NOTHING INVENTED. Every <loc> is a page the last successful crawl fetched
 *    with a 200 and that isn't noindexed. A sitemap of URLs the site doesn't
 *    serve is worse than no sitemap — it teaches Google to distrust the file.
 * 3. NO METADATA THEATRE. No <priority>, no <changefreq> — Google ignores both,
 *    and inventing them would be a lie with a schema. <lastmod> is emitted ONLY
 *    when the crawl actually OBSERVED one (a sitemap entry's own lastmod). A
 *    crawl timestamp is when WE looked, not when the PAGE changed; stamping
 *    every URL with today's date is the single most common way sites get their
 *    lastmod ignored wholesale. In homepage-crawl mode — the mode that makes a
 *    site eligible here at all — nothing observed a lastmod, so nothing is
 *    emitted, and that is the honest file.
 */

import { createProposal, ApiError } from './actions.js';
import { fixedResourceSpec, readResource, RESOURCE_MAX_CHARS } from './overrides.js';
import type { SiteConfig } from './config.js';
import type { AgentDeps } from './deps.js';

/** The page fields buildSitemap needs — a subset of a page_snapshots row. */
export type SitemapPage = {
  path: string;
  /** SQLite stores this as 0/1; a boolean works too. */
  noindex: number | boolean | null;
  status: number;
  lastmod?: string | null;
  error?: string | null;
};

/** The config fields the generator reads. */
export type SitemapConfig = Pick<SiteConfig, 'siteUrl'>;

/**
 * Hard entry bound. The sitemaps protocol allows 50,000 URLs per file, but a
 * managed sitemap also has to survive `RESOURCE_MAX_CHARS` (100k) as a proposal
 * body, and the crawl itself never returns more than MAX_TOTAL_ENTRIES (2000)
 * pages. This is the crawl's ceiling, so the cap here is a backstop, not a
 * routine truncation — a site that would exceed the byte budget is refused
 * loudly by `generateSitemap` rather than silently shortened, because a URL
 * missing from a sitemap is invisible in a way a short llms.txt is not.
 */
export const SITEMAP_MAX_ENTRIES = 2000;

/**
 * A path we are willing to turn into a <loc>. Snapshot paths come from a URL's
 * own pathname, so this is a tripwire rather than a parser: no whitespace, no
 * backslash (a URL parser treats one as a separator), no control characters.
 */
// eslint-disable-next-line no-control-regex
const CLEAN_PATH = /^[^\s\\\u0000-\u001f\u007f]*$/;

/**
 * A `<lastmod>` we are willing to repeat. The value came off someone else's
 * sitemap, and the sitemaps protocol wants W3C Datetime; anything we can't
 * recognize is dropped rather than passed through, because an unparseable
 * lastmod invalidates the entry for some consumers and tells us nothing anyway.
 */
const W3C_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** XML text escaping — the five predefined entities, ampersand first. */
const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Build the /sitemap.xml body. Pure — feed it page rows and the site URL.
 *
 * Excluded: non-200 pages, rows that errored, noindexed pages (a sitemap says
 * "please index this"; a noindexed page in one is a contradiction the rules
 * already flag as `noindex_in_sitemap`), and anything whose path isn't a clean
 * root-relative path. Deduped by path, first occurrence wins.
 *
 * Ordering is the caller's, preserved — a stable crawl gives byte-identical
 * output, so a re-generated sitemap that changed nothing produces no diff and
 * no churning proposal.
 */
export function buildSitemap(pages: SitemapPage[], config: SitemapConfig): string {
  const base = config.siteUrl.replace(/\/+$/, '');
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const p of pages) {
    if (p.status !== 200 || p.noindex || p.error) continue;
    // Paths come from a URL's own pathname, so this is a tripwire rather than a
    // parser: anything that isn't a plain root-relative path did not come from
    // where we think it did, and does not belong in a file we publish.
    if (!p.path.startsWith('/') || p.path.includes('//') || p.path.includes('..') || !CLEAN_PATH.test(p.path)) continue;
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    if (entries.length >= SITEMAP_MAX_ENTRIES) break;
    const lastmod = p.lastmod && W3C_DATE.test(p.lastmod.trim()) ? p.lastmod.trim() : null;
    entries.push(
      `  <url>\n    <loc>${xmlEscape(`${base}${p.path}`)}</loc>${lastmod ? `\n    <lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}\n  </url>`
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    entries.length ? entries.join('\n') + '\n' : ''
  }</urlset>\n`;
}

/**
 * Generate the current /sitemap.xml body from the latest SUCCESSFUL crawl
 * (ok = 1 — a half-finished run would publish a sitemap missing half the site,
 * which reads to a crawler as "these pages were deleted").
 */
export async function generateSitemap(
  deps: Pick<AgentDeps, 'db' | 'config'>
): Promise<{ body: string; entries: number; runId: number | null }> {
  const run = await deps.db.prepare('SELECT id FROM crawl_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1').first<{ id: number }>();
  if (!run) return { body: buildSitemap([], deps.config), entries: 0, runId: null };
  const rows = (
    await deps.db.prepare('SELECT path, status, noindex, lastmod, error FROM page_snapshots WHERE run_id = ? ORDER BY path')
      .bind(run.id)
      .all<SitemapPage>()
  ).results;
  const body = buildSitemap(rows, deps.config);
  // No banned-terms gate, deliberately, unlike llms.txt: that file carries the
  // site's own PROSE (titles, descriptions) and a banned term in it is copy we
  // would be republishing. A sitemap carries URLs and nothing else — refusing
  // to publish a page list because a slug contains a discouraged word would
  // hide a real page from search over a vocabulary preference.
  //
  // Count entries off the rendered body so buildSitemap stays the single place
  // that decides what is listed.
  const entries = body.split('\n').filter((l) => l.startsWith('    <loc>')).length;
  if (body.length > RESOURCE_MAX_CHARS) {
    throw new ApiError(
      `your site has more pages than we can publish in a managed sitemap (${entries} URLs, ${body.length} chars, max ${RESOURCE_MAX_CHARS}) — a site this size should serve its own sitemap`,
      409
    );
  }
  return { body, entries, runId: run.id };
}

/**
 * ORIGIN WINS, enforced. Why a site may NOT have a managed sitemap, or null.
 *
 * The condition is exactly the one the crawl already recorded: an OPEN
 * `sitemap_missing` finding, which `discoveryFindings` opens when and only when
 * discovery fell back to a homepage crawl (no sitemap, an empty one, or one we
 * couldn't parse), and which auto-resolves the first run a sitemap parses. So
 * the eligibility test and the crawler's own verdict cannot drift apart — and a
 * site that later publishes its own sitemap stops being eligible on the next
 * crawl without anyone having to remember to check.
 *
 * Exported so a host can gate a button on the same answer the POST enforces.
 */
export async function sitemapProposalBlockedReason(deps: Pick<AgentDeps, 'db'>): Promise<string | null> {
  const open = await deps.db.prepare("SELECT id FROM findings WHERE rule = 'sitemap_missing' AND status = 'open' LIMIT 1")
    .first<{ id: number }>();
  if (open) return null;
  return 'your site already serves a sitemap we can read — we won’t publish one over it. Managed sitemaps are only for sites whose own sitemap is missing or unreadable.';
}

/**
 * Propose the generated /sitemap.xml for approval. current_value is whatever
 * body is live in KV right now (null on the first ever proposal), so the
 * reviewer sees a real diff and a later revert has something to restore.
 */
export async function createSitemapProposal(deps: Pick<AgentDeps, 'db' | 'config' | 'overrides'>) {
  const spec = fixedResourceSpec('sitemap_xml');
  const blocked = await sitemapProposalBlockedReason(deps);
  if (blocked) throw new ApiError(blocked, 409);
  const { body, entries } = await generateSitemap(deps);
  // An empty <urlset> is not a sitemap, it is an instruction to deindex: a
  // crawler that reads it learns the site claims zero pages.
  if (entries < 1) throw new ApiError('no crawled pages to list — run a crawl first', 409);
  const current = await readResource(deps, spec.path);
  console.log(JSON.stringify({ evt: 'sitemap_proposed', entries, bytes: body.length }));
  return createProposal(
    deps,
    {
      path: spec.path,
      field: 'sitemap_xml',
      value: body,
      currentValue: current,
      rationale: `generated from the latest crawl (${entries} ${entries === 1 ? 'page' : 'pages'})`,
    },
    () => null // unused: resource fields don't run the description validator
  );
}
