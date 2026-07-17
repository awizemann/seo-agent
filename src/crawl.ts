/**
 * Sitemap-driven self-crawl. Fetches every URL in the site's sitemap, parses
 * the delivered <head> with HTMLRewriter, and snapshots what crawlers actually
 * received into D1. The snapshot diff (vs the previous run) is what detects
 * new pages — including future-dated articles that go live at UTC midnight
 * with no deploy event.
 */

const USER_AGENT = 'seo-agent/1.0 (self-audit; +https://github.com/awizemann/seo-agent)';
const FETCH_CONCURRENCY = 5;
const PAGE_TIMEOUT_MS = 15_000;

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

function parseSitemap(xml: string, origin: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const block of xml.match(/<url>[\s\S]*?<\/url>/g) ?? []) {
    const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1];
    if (!loc || !loc.startsWith(origin)) continue;
    entries.push({ loc, lastmod: block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1] ?? null });
  }
  return entries;
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
        .on('title', {
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

export async function runCrawl(env: Env): Promise<{ runId: number; snapshots: PageSnapshot[] }> {
  const startedAt = new Date().toISOString();
  const run = await env.DB.prepare('INSERT INTO crawl_runs (started_at) VALUES (?) RETURNING id')
    .bind(startedAt)
    .first<{ id: number }>();
  if (!run) throw new Error('failed to create crawl run');

  const origin = new URL(env.SITE_URL).origin;
  const sitemapRes = await fetch(`${origin}/sitemap.xml`, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!sitemapRes.ok) throw new Error(`sitemap fetch failed: ${sitemapRes.status}`);
  const entries = parseSitemap(await sitemapRes.text(), origin);
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
  await env.DB.batch(
    snapshots.map((s) =>
      insert.bind(
        run.id,
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
  await env.DB.prepare('UPDATE crawl_runs SET finished_at = ?, url_count = ?, ok = 1 WHERE id = ?')
    .bind(new Date().toISOString(), snapshots.length, run.id)
    .run();

  console.log(JSON.stringify({ evt: 'crawl_complete', runId: run.id, urls: snapshots.length }));
  return { runId: run.id, snapshots };
}
