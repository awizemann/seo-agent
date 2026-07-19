/**
 * Sitemap-driven self-crawl. Fetches every URL in the site's sitemap, parses
 * the delivered <head> with HTMLRewriter, and snapshots what crawlers actually
 * received into D1. The snapshot diff (vs the previous run) is what detects
 * new pages — including future-dated articles that go live at UTC midnight
 * with no deploy event.
 */

import { VERSION } from './version.js';

const USER_AGENT = `seo-agent/${VERSION} (self-audit; +https://github.com/awizemann/seo-agent)`;
const FETCH_CONCURRENCY = 5;
const PAGE_TIMEOUT_MS = 15_000;
// <sitemapindex> fan-out: fetch at most this many same-origin child sitemaps and
// keep at most this many total URLs across them (guards the subrequest budget).
const MAX_CHILD_SITEMAPS = 50;
const MAX_TOTAL_ENTRIES = 2000;
const SNAPSHOT_BATCH_SIZE = 500; // D1 statements per batch (repo convention, see gsc.ts)
const SNAPSHOT_RETENTION_DAYS = 90;

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
    if (!loc || !loc.startsWith(origin)) continue;
    entries.push({ loc, lastmod: block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1] ?? null });
  }
  const sitemaps: string[] = [];
  for (const block of xml.match(/<sitemap>[\s\S]*?<\/sitemap>/g) ?? []) {
    const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
    if (loc && loc.startsWith(origin)) sitemaps.push(loc);
  }
  return { entries, sitemaps };
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

async function fetchPage(entry: SitemapEntry): Promise<PageSnapshot> {
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

  try {
    const res = await fetch(entry.loc, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      redirect: 'manual', // a sitemap URL that redirects is itself a finding
    });
    snap.status = res.status;

    if ((res.headers.get('content-type') || '').includes('text/html') && res.body) {
      let title = '';
      let jsonldRaw = '';
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
            if (/noindex/i.test(el.getAttribute('content') || '')) snap.noindex = true;
          },
        })
        .on('script[type="application/ld+json"]', {
          text(t) {
            jsonldRaw += t.text;
          },
        });
      // Drain the transformed stream so the handlers above actually run.
      await rewriter.transform(res).arrayBuffer();
      snap.title = title.trim() || null;
      snap.jsonldTypes = [...new Set([...jsonldRaw.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map((m) => m[1]))];
    } else {
      // Non-HTML or empty body (e.g. a redirect) — status alone is the signal.
      await res.body?.cancel();
    }
  } catch (err) {
    snap.error = err instanceof Error ? err.message : String(err);
  }
  return snap;
}

export async function runCrawl(env: Env, runId: number): Promise<{ runId: number; snapshots: PageSnapshot[] }> {
  const origin = new URL(env.SITE_URL).origin;
  const sitemapRes = await fetch(`${origin}/sitemap.xml`, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!sitemapRes.ok) throw new Error(`sitemap fetch failed: ${sitemapRes.status}`);

  const root = parseSitemap(await sitemapRes.text(), origin);
  let rawEntries = root.entries;
  // <sitemapindex>: fetch one level of same-origin child sitemaps and merge.
  if (rawEntries.length === 0 && root.sitemaps.length > 0) {
    const children = root.sitemaps.slice(0, MAX_CHILD_SITEMAPS);
    const nested = await Promise.all(
      children.map(async (loc) => {
        try {
          const r = await fetch(loc, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
          if (!r.ok) return [] as SitemapEntry[];
          return parseSitemap(await r.text(), origin).entries;
        } catch {
          return [] as SitemapEntry[];
        }
      })
    );
    rawEntries = nested.flat();
  }

  const { entries, truncated } = dedupeAndCap(rawEntries, MAX_TOTAL_ENTRIES);
  if (truncated) console.log(JSON.stringify({ evt: 'sitemap_truncated', kept: entries.length, cap: MAX_TOTAL_ENTRIES }));
  if (entries.length === 0) throw new Error('sitemap parsed to zero URLs');

  const queue = [...entries];
  const snapshots: PageSnapshot[] = [];
  const workers = Array.from({ length: FETCH_CONCURRENCY }, async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      snapshots.push(await fetchPage(e));
    }
  });
  await Promise.all(workers);

  const fetchedAt = new Date().toISOString();
  const insert = env.DB.prepare(
    `INSERT INTO page_snapshots
     (run_id, path, status, title, description, canonical, og_image, og_type, jsonld_types, noindex, lastmod, error, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Chunk the batch — one DB.batch per SNAPSHOT_BATCH_SIZE statements (repo
  // convention; a single unbounded batch can exceed D1's per-batch limit).
  for (let i = 0; i < snapshots.length; i += SNAPSHOT_BATCH_SIZE) {
    await env.DB.batch(
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
  await env.DB.prepare('UPDATE crawl_runs SET finished_at = ?, url_count = ?, ok = 1 WHERE id = ?')
    .bind(new Date().toISOString(), snapshots.length, runId)
    .run();

  console.log(JSON.stringify({ evt: 'crawl_complete', runId, urls: snapshots.length }));
  return { runId, snapshots };
}

/**
 * Retention: drop page_snapshots belonging to crawl runs older than 90 days.
 * Rules only ever read the current run and the single previous ok run, so older
 * snapshots have no reader. The crawl_runs rows themselves are tiny and kept.
 */
export async function prunePageSnapshots(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM page_snapshots WHERE run_id IN (SELECT id FROM crawl_runs WHERE started_at < ?)')
    .bind(cutoff)
    .run();
}
