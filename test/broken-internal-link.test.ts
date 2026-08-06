import { describe, it, expect } from 'vitest';
import { runRules } from '../src/rules';
import type { PageSnapshot, Discovery } from '../src/crawl';

// --- Discovery-aware error rules ----------------------------------------------
// A page that fails to load is a different FINDING depending on how the crawl
// found it. In sitemap mode "remove the URL from the sitemap" is a real fix; in
// homepage_crawl mode there is no sitemap, so the same status raises
// `broken_internal_link` instead — and never `sitemap_url_redirects`, because
// there is no sitemap to point at final URLs.

const snap = (over: Partial<PageSnapshot> & { path: string }): PageSnapshot => ({
  status: 200,
  title: null,
  description: null,
  canonical: null,
  ogImage: null,
  jsonLdTypes: [],
  error: null,
  ...over,
});

function fakeDb() {
  const inserted: any[][] = [];
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: {} }),
    __sql: sql,
    __binds: binds,
  });
  return {
    inserted,
    db: {
      prepare: (sql: string) => stmt(sql),
      batch: async (statements: any[]) => {
        for (const s of statements) if (/INSERT INTO findings/.test(s.__sql)) inserted.push(s.__binds);
        return [];
      },
    } as any,
  };
}

const config = { siteUrl: 'https://acme.test', shellTitle: '', titleBrandSuffix: '', articlePathPrefix: '' } as any;
const homepage: Discovery = { mode: 'homepage_crawl', reason: 'no sitemap found', pages: 2 };
const sitemap: Discovery = { mode: 'sitemap', reason: null, pages: 2 };

describe('error findings are discovery-aware', () => {
  it('homepage_crawl: a 4xx page is a broken internal link, not a sitemap error', async () => {
    const { inserted, db } = fakeDb();
    await runRules({ db, config }, 1, [snap({ path: '/gone', status: 404 })], [], homepage);
    const rules = inserted.map((b) => b[3]);
    expect(rules).toContain('broken_internal_link');
    expect(rules).not.toContain('sitemap_url_error');
  });

  it('homepage_crawl: a fetch error also raises broken_internal_link with the error detail', async () => {
    const { inserted, db } = fakeDb();
    await runRules({ db, config }, 1, [snap({ path: '/down', status: 0, error: 'timeout' })], [], homepage);
    const row = inserted.find((b) => b[3] === 'broken_internal_link');
    expect(row).toBeDefined();
    expect(row![5]).toContain('timeout');
  });

  it('homepage_crawl: a stray 3xx snapshot raises nothing (no sitemap to correct)', async () => {
    const { inserted, db } = fakeDb();
    await runRules({ db, config }, 1, [snap({ path: '/moved', status: 301 })], [], homepage);
    expect(inserted).toHaveLength(0);
  });

  it('sitemap mode keeps the sitemap rules', async () => {
    const { inserted, db } = fakeDb();
    await runRules(
      { db, config },
      1,
      [snap({ path: '/gone', status: 404 }), snap({ path: '/moved', status: 301 })],
      [],
      sitemap
    );
    const rules = inserted.map((b) => b[3]);
    expect(rules).toContain('sitemap_url_error');
    expect(rules).toContain('sitemap_url_redirects');
    expect(rules).not.toContain('broken_internal_link');
  });

  it('omitted discovery behaves like sitemap mode (back-compat for existing callers)', async () => {
    const { inserted, db } = fakeDb();
    await runRules({ db, config }, 1, [snap({ path: '/gone', status: 404 })]);
    expect(inserted.map((b) => b[3])).toContain('sitemap_url_error');
  });
});
