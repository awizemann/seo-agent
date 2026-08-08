/**
 * Sitemap-driven self-crawl. Fetches every URL in the site's sitemap, parses
 * the delivered <head> with HTMLRewriter, and snapshots what crawlers actually
 * received into D1. The snapshot diff (vs the previous run) is what detects
 * new pages — including future-dated articles that go live at UTC midnight
 * with no deploy event.
 *
 * When the site has no usable sitemap (missing, empty, or unparseable), the
 * crawl does NOT fail: it falls back to a bounded same-origin breadth-first
 * link crawl from `/`. Small sites without a sitemap are exactly the ones that
 * need an audit most. The run records which discovery mode ran so a host can
 * say so honestly, and `sitemap_missing` opens as a finding in its own right.
 */

import type { AgentDeps } from './deps.js';
import { BYPASS_HEADER, BYPASS_RESOURCE } from './robotstxt.js';
import { VERSION } from './version.js';

const USER_AGENT = `seo-agent/${VERSION} (self-audit; +https://github.com/citeworthyio/seo-agent)`;

/**
 * DISCOVERY MUST READ THE ORIGIN'S SITEMAP, NEVER OUR OWN (v1.19.1).
 *
 * Since v1.19.0 the agent can publish a generated `/sitemap.xml` as a resource
 * override, which the injector serves BEFORE the origin. Without this header
 * the very next crawl would fetch that file back — and three things would go
 * wrong at once: discovery would run off a page list we wrote (so a page the
 * site added but nothing links to could never be discovered again), the
 * `sitemap_missing` finding would resolve because "a sitemap parses" (it is
 * ours), and the offer to REGENERATE would vanish while the stale file kept
 * serving. The bypass keeps the question honest: does the SITE serve a usable
 * sitemap? Origin-wins is decided on the origin's own answer, always.
 */
const SITEMAP_FETCH_HEADERS = { 'user-agent': USER_AGENT, [BYPASS_HEADER]: BYPASS_RESOURCE };
const FETCH_CONCURRENCY = 5;
const PAGE_TIMEOUT_MS = 15_000;
// <sitemapindex> fan-out: fetch at most this many same-origin child sitemaps and
// keep at most this many total URLs across them (guards the subrequest budget).
const MAX_CHILD_SITEMAPS = 50;
const MAX_TOTAL_ENTRIES = 2000;
const SNAPSHOT_BATCH_SIZE = 500; // D1 statements per batch (repo convention, see gsc.ts)
const SNAPSHOT_RETENTION_DAYS = 90;

// --- Homepage-crawl fallback bounds -----------------------------------------
// Every one of these is a hard stop, and together they are what makes crawling
// an unknown site safe: an infinite link space (calendars, faceted filters,
// session ids) can cost at most MAX_CRAWL_DEPTH levels and `cap` fetches before
// the crawl ends, because the frontier is only ever grown out of a `seen` set
// that is itself capped at `cap`.
export const MAX_CRAWL_DEPTH = 3; // levels below `/` — the homepage is depth 0
const MAX_LINKS_PER_PAGE = 200; // ignore the tail of a link-bomb page
// Extensions we never fetch as pages. Belt to the content-type braces in
// fetchPage: this one saves the subrequest, that one saves the parse.
const NON_HTML_EXT =
  /\.(?:jpe?g|png|gif|webp|avif|bmp|ico|svg|css|js|mjs|cjs|map|json|xml|rss|atom|txt|pdf|zip|gz|tgz|bz2|7z|rar|dmg|exe|apk|mp[34g]|m4[av]|wav|ogg|oga|webm|mov|avi|mkv|woff2?|ttf|otf|eot|csv|tsv|xlsx?|docx?|pptx?)$/i;

export type DiscoveryMode = 'sitemap' | 'homepage_crawl';
/**
 * How this run found its URLs. `reason` is non-null only in homepage_crawl mode
 * and says what was wrong with the sitemap, in the words a host can show a user.
 */
export type Discovery = { mode: DiscoveryMode; reason: string | null; pages: number };

export type RobotsRules = { allow: string[]; disallow: string[] };

/**
 * Parse robots.txt into the allow/disallow patterns that bind ONE agent.
 * Group selection follows the standard: if any group names our agent token
 * explicitly, only those groups apply; otherwise the `*` groups do. A blank
 * `Disallow:` is the "allow everything" idiom and contributes no pattern.
 * Exported for tests.
 */
export function parseRobotsRules(txt: string, agent: string): RobotsRules {
  const wanted = agent.toLowerCase();
  // Collect every group as (agents, directives). Consecutive User-agent lines
  // share the directives that follow them.
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  let sawDirective = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || sawDirective) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
        sawDirective = false;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (field !== 'allow' && field !== 'disallow') continue;
    if (!current) continue; // directive before any User-agent line: not ours to apply
    sawDirective = true;
    if (field === 'disallow' && value === '') continue; // "Disallow:" = allow all
    if (value === '') continue;
    current[field].push(value);
  }

  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && wanted.includes(a)));
  const applicable = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  return {
    allow: applicable.flatMap((g) => g.allow),
    disallow: applicable.flatMap((g) => g.disallow),
  };
}

/** Length of the match a robots pattern makes on `path`, or -1 for no match. */
function robotsMatchLength(path: string, pattern: string): number {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const rx = new RegExp(
    '^' + body.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''),
    ''
  );
  return rx.test(path) ? body.replace(/\*/g, '').length : -1;
}

/**
 * Standard precedence: the longest matching pattern wins, and Allow beats
 * Disallow on an equal-length tie. Exported for tests.
 */
export function robotsAllows(path: string, rules: RobotsRules): boolean {
  let bestDisallow = -1;
  for (const p of rules.disallow) bestDisallow = Math.max(bestDisallow, robotsMatchLength(path, p));
  if (bestDisallow < 0) return true;
  let bestAllow = -1;
  for (const p of rules.allow) bestAllow = Math.max(bestAllow, robotsMatchLength(path, p));
  return bestAllow >= bestDisallow;
}

/**
 * Resolve one discovered href against the page it was found on, and return the
 * URL we would crawl — or null when we would not. Rejects other origins, other
 * schemes (mailto:/tel:/javascript:), and paths that name a non-HTML file.
 * Fragments are stripped, so `/a` and `/a#top` are one URL, not two.
 * Exported for tests.
 */
export function normalizeLink(href: string, base: string, origin: string): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith('#')) return null;
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin !== new URL(origin).origin) return null;
  if (NON_HTML_EXT.test(u.pathname)) return null;
  u.hash = '';
  return u.toString();
}

export type PageSnapshot = {
  path: string;
  status: number;
  title: string | null;
  description: string | null;
  canonical: string | null;
  ogImage: string | null;
  ogType: string | null;
  jsonldTypes: string[];
  noindex: boolean;
  lastmod: string | null;
  error: string | null;
};

type SitemapEntry = { loc: string; lastmod: string | null };
export type ParsedSitemap = { entries: SitemapEntry[]; sitemaps: string[] };

/**
 * Parse ONE sitemap document. A <urlset> yields page entries; a <sitemapindex>
 * yields child sitemap locations (the caller fetches those one level deep).
 * Same-origin only. Exported for tests.
 */
export function parseSitemap(xml: string, origin: string): ParsedSitemap {
  const entries: SitemapEntry[] = [];
  for (const block of xml.match(/<url>[\s\S]*?<\/url>/g) ?? []) {
    const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
    if (!loc || !sameOrigin(loc, origin)) continue;
    entries.push({ loc, lastmod: block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1] ?? null });
  }
  const sitemaps: string[] = [];
  for (const block of xml.match(/<sitemap>[\s\S]*?<\/sitemap>/g) ?? []) {
    const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
    if (loc && sameOrigin(loc, origin)) sitemaps.push(loc);
  }
  return { entries, sitemaps };
}

/**
 * True origin comparison, not a string prefix — a prefix check admits
 * userinfo tricks (https://good.com@evil.net/) and lookalike hosts
 * (https://good.com.evil.net/). Unparseable locs are rejected.
 */
function sameOrigin(loc: string, origin: string): boolean {
  try {
    return new URL(loc).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** Dedupe entries by loc (first occurrence wins) and cap the total. Exported for tests. */
export function dedupeAndCap(entries: SitemapEntry[], max: number): { entries: SitemapEntry[]; truncated: boolean } {
  const seen = new Set<string>();
  const out: SitemapEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.loc)) continue;
    seen.add(e.loc);
    out.push(e);
  }
  const truncated = out.length > max;
  return { entries: truncated ? out.slice(0, max) : out, truncated };
}

/**
 * One fetched page: the snapshot, plus (when `collectLinks`) the same-origin
 * followable links found on it and the Location of a redirect. The link fields
 * are empty in sitemap mode — discovery there is the sitemap's job.
 */
type FetchedPage = { snap: PageSnapshot; links: string[]; location: string | null };

async function fetchPage(entry: SitemapEntry, collectLinks = false): Promise<FetchedPage> {
  const path = new URL(entry.loc).pathname;
  const snap: PageSnapshot = {
    path,
    status: 0,
    title: null,
    description: null,
    canonical: null,
    ogImage: null,
    ogType: null,
    jsonldTypes: [],
    noindex: false,
    lastmod: entry.lastmod,
    error: null,
  };

  const links: string[] = [];
  let location: string | null = null;

  try {
    const res = await fetch(entry.loc, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      redirect: 'manual', // a sitemap URL that redirects is itself a finding
    });
    snap.status = res.status;
    if (collectLinks && res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) location = normalizeLink(loc, entry.loc, entry.loc);
    }

    if ((res.headers.get('content-type') || '').includes('text/html') && res.body) {
      let title = '';
      let jsonldRaw = '';
      // A page-level `nofollow` (meta robots) retracts every link on the page.
      // It can appear after links in source order, so links are collected into
      // a scratch list and only promoted once the whole document has streamed.
      let pageNofollow = false;
      const scratchLinks: string[] = [];
      const rewriter = new HTMLRewriter()
        // `head > title` (child combinator) so an inline-SVG <title> in the body
        // can't corrupt the page title — only the real document title matches.
        .on('head > title', {
          text(t) {
            title += t.text;
          },
        })
        .on('meta[name="description"]', {
          element(el) {
            snap.description = el.getAttribute('content');
          },
        })
        .on('link[rel="canonical"]', {
          element(el) {
            snap.canonical = el.getAttribute('href');
          },
        })
        .on('meta[property="og:image"]', {
          element(el) {
            snap.ogImage = el.getAttribute('content');
          },
        })
        .on('meta[property="og:type"]', {
          element(el) {
            snap.ogType = el.getAttribute('content');
          },
        })
        .on('meta[name="robots"]', {
          element(el) {
            const content = el.getAttribute('content') || '';
            if (/noindex/i.test(content)) snap.noindex = true;
            if (/nofollow|\bnone\b/i.test(content)) pageNofollow = true;
          },
        })
        .on('script[type="application/ld+json"]', {
          text(t) {
            jsonldRaw += t.text;
          },
        });
      if (collectLinks) {
        rewriter.on('a[href]', {
          element(el) {
            if (scratchLinks.length >= MAX_LINKS_PER_PAGE) return;
            if (/\bnofollow\b/i.test(el.getAttribute('rel') || '')) return;
            const href = el.getAttribute('href');
            if (href) scratchLinks.push(href);
          },
        });
      }
      // Drain the transformed stream so the handlers above actually run.
      await rewriter.transform(res).arrayBuffer();
      snap.title = title.trim() || null;
      snap.jsonldTypes = [...new Set([...jsonldRaw.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map((m) => m[1]))];
      if (collectLinks && !pageNofollow) {
        for (const href of scratchLinks) {
          const url = normalizeLink(href, entry.loc, entry.loc);
          if (url) links.push(url);
        }
      }
    } else {
      // Non-HTML or empty body (e.g. a redirect) — status alone is the signal.
      await res.body?.cancel();
    }
  } catch (err) {
    snap.error = err instanceof Error ? err.message : String(err);
  }
  return { snap, links, location };
}

/**
 * Bounded same-origin breadth-first crawl from `/`, used when the sitemap is
 * unusable. Bounds, all of them hard:
 *   - same origin only (true origin comparison, not a prefix test),
 *   - robots.txt Disallow honoured for our own agent token, then `*`,
 *   - rel="nofollow" links and meta-robots nofollow pages contribute no links,
 *   - at most MAX_CRAWL_DEPTH levels below the homepage,
 *   - at most `cap` pages fetched AND at most `cap` URLs ever enqueued,
 *   - at most MAX_LINKS_PER_PAGE links taken from any single page,
 *   - non-HTML skipped by extension before the fetch and by content-type after.
 * A same-origin redirect is followed by enqueueing its target rather than
 * snapshotting the hop, so the fallback does not manufacture redirect findings
 * out of link-following (in sitemap mode a redirect IS the finding, and there
 * this function is not involved).
 */
async function homepageCrawl(origin: string, cap: number): Promise<PageSnapshot[]> {
  let robots: RobotsRules = { allow: [], disallow: [] };
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (res.ok) robots = parseRobotsRules(await res.text(), 'seo-agent');
    else await res.body?.cancel();
  } catch {
    // No robots.txt (or unreachable) — nothing to honour, crawl the bounds below.
  }

  const root = `${origin}/`;
  const seen = new Set<string>([root]);
  const snapshots: PageSnapshot[] = [];
  let frontier = [root];

  const admit = (url: string): boolean => {
    if (seen.size >= cap) return false; // the frontier can never outgrow the cap
    if (seen.has(url)) return false;
    if (!robotsAllows(new URL(url).pathname, robots)) return false;
    seen.add(url);
    return true;
  };

  for (let depth = 0; depth <= MAX_CRAWL_DEPTH && frontier.length > 0 && snapshots.length < cap; depth++) {
    const queue = [...frontier];
    const next: string[] = [];
    await Promise.all(
      Array.from({ length: FETCH_CONCURRENCY }, async () => {
        for (let url = queue.shift(); url; url = queue.shift()) {
          if (snapshots.length >= cap) return;
          const { snap, links, location } = await fetchPage({ loc: url, lastmod: null }, true);
          // Followed redirect: enqueue the target, don't snapshot the hop.
          if (location && snap.status >= 300 && snap.status < 400) {
            if (admit(location)) next.push(location);
            continue;
          }
          snapshots.push(snap);
          for (const link of links) if (admit(link)) next.push(link);
        }
      })
    );
    frontier = next;
  }

  console.log(JSON.stringify({ evt: 'homepage_crawl_done', pages: snapshots.length, depth: MAX_CRAWL_DEPTH, cap }));
  return snapshots;
}

export async function runCrawl(
  deps: Pick<AgentDeps, 'db' | 'config'>,
  runId: number
): Promise<{ runId: number; snapshots: PageSnapshot[]; discovery: Discovery }> {
  const origin = new URL(deps.config.siteUrl).origin;
  // config.pageCap is already clamped to [1, MAX_TOTAL_ENTRIES] at resolve time.
  const cap = Math.min(deps.config.pageCap, MAX_TOTAL_ENTRIES);

  // --- Discovery: the sitemap, or the homepage when the sitemap can't serve --
  let rawEntries: SitemapEntry[] = [];
  // Non-null once the sitemap has failed us, in the words a host can show.
  let fallbackReason: string | null = null;
  try {
    const sitemapRes = await fetch(`${origin}/sitemap.xml`, {
      headers: SITEMAP_FETCH_HEADERS,
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!sitemapRes.ok) {
      await sitemapRes.body?.cancel();
      fallbackReason = `no sitemap at /sitemap.xml (HTTP ${sitemapRes.status})`;
    } else {
      const root = parseSitemap(await sitemapRes.text(), origin);
      rawEntries = root.entries;
      // <sitemapindex>: fetch one level of same-origin child sitemaps and merge.
      if (rawEntries.length === 0 && root.sitemaps.length > 0) {
        const children = root.sitemaps.slice(0, MAX_CHILD_SITEMAPS);
        const nested = await Promise.all(
          children.map(async (loc) => {
            try {
              const r = await fetch(loc, { headers: SITEMAP_FETCH_HEADERS, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
              if (!r.ok) return [] as SitemapEntry[];
              return parseSitemap(await r.text(), origin).entries;
            } catch {
              return [] as SitemapEntry[];
            }
          })
        );
        rawEntries = nested.flat();
      }
      if (rawEntries.length === 0) fallbackReason = 'the sitemap at /sitemap.xml lists no usable URLs';
    }
  } catch (err) {
    fallbackReason = `the sitemap at /sitemap.xml could not be fetched (${err instanceof Error ? err.message : String(err)})`;
  }

  let snapshots: PageSnapshot[];
  if (fallbackReason === null) {
    const { entries, truncated } = dedupeAndCap(rawEntries, cap);
    if (truncated) console.log(JSON.stringify({ evt: 'sitemap_truncated', kept: entries.length, cap }));
    const queue = [...entries];
    snapshots = [];
    const workers = Array.from({ length: FETCH_CONCURRENCY }, async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        snapshots.push((await fetchPage(e)).snap);
      }
    });
    await Promise.all(workers);
  } else {
    console.log(JSON.stringify({ evt: 'sitemap_fallback', reason: fallbackReason }));
    snapshots = await homepageCrawl(origin, cap);
    // Both discovery routes came up empty: there is genuinely nothing to audit,
    // and a run that recorded zero pages as a success would erase every finding
    // the site has (the rules auto-resolve what the crawl no longer sees). A
    // crawl that only ever saw errors counts as empty — one 404 snapshot is not
    // a page list, and treating it as one would resolve the whole backlog.
    if (!snapshots.some((s) => s.status >= 200 && s.status < 300)) {
      throw new Error(`${fallbackReason}, and no pages were reachable by crawling from the homepage`);
    }
  }
  const discovery: Discovery = {
    mode: fallbackReason === null ? 'sitemap' : 'homepage_crawl',
    reason: fallbackReason,
    pages: snapshots.length,
  };

  const fetchedAt = new Date().toISOString();
  const insert = deps.db.prepare(
    `INSERT INTO page_snapshots
     (run_id, path, status, title, description, canonical, og_image, og_type, jsonld_types, noindex, lastmod, error, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Chunk the batch — one DB.batch per SNAPSHOT_BATCH_SIZE statements (repo
  // convention; a single unbounded batch can exceed D1's per-batch limit).
  for (let i = 0; i < snapshots.length; i += SNAPSHOT_BATCH_SIZE) {
    await deps.db.batch(
      snapshots.slice(i, i + SNAPSHOT_BATCH_SIZE).map((s) =>
        insert.bind(
          runId,
          s.path,
          s.status,
          s.title,
          s.description,
          s.canonical,
          s.ogImage,
          s.ogType,
          s.jsonldTypes.join(',') || null,
          s.noindex ? 1 : 0,
          s.lastmod,
          s.error,
          fetchedAt
        )
      )
    );
  }
  await deps.db.prepare('UPDATE crawl_runs SET finished_at = ?, url_count = ?, ok = 1 WHERE id = ?')
    .bind(new Date().toISOString(), snapshots.length, runId)
    .run();

  console.log(JSON.stringify({ evt: 'crawl_complete', runId, urls: snapshots.length, discovery: discovery.mode }));
  return { runId, snapshots, discovery };
}

/**
 * Retention: drop page_snapshots belonging to crawl runs older than 90 days.
 * Rules only ever read the current run and the single previous ok run, so older
 * snapshots have no reader. The crawl_runs rows themselves are tiny and kept.
 */
export async function prunePageSnapshots(deps: Pick<AgentDeps, 'db'>): Promise<void> {
  const cutoff = new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await deps.db.prepare('DELETE FROM page_snapshots WHERE run_id IN (SELECT id FROM crawl_runs WHERE started_at < ?)')
    .bind(cutoff)
    .run();
}
