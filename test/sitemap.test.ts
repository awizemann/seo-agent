import { describe, it, expect } from 'vitest';
import {
  buildSitemap,
  generateSitemap,
  createSitemapProposal,
  sitemapProposalBlockedReason,
  type SitemapPage,
  type SitemapConfig,
} from '../src/sitemap';
import { createProposal, decideProposal, revertById, ApiError } from '../src/actions';
import { resourceKey, RESOURCE_FIELDS, fixedResourceSpec } from '../src/overrides';

const config: SitemapConfig = { siteUrl: 'https://example.com' };

const page = (p: Partial<SitemapPage> & { path: string }): SitemapPage => ({
  status: 200,
  noindex: 0,
  lastmod: null,
  error: null,
  ...p,
});

const locs = (xml: string): string[] => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// buildSitemap — pure.
// ---------------------------------------------------------------------------

describe('buildSitemap', () => {
  it('emits a valid urlset with one <url> per crawled page', () => {
    const out = buildSitemap([page({ path: '/' }), page({ path: '/a' })], config);
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(out).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(out.trimEnd().endsWith('</urlset>')).toBe(true);
    expect(locs(out)).toEqual(['https://example.com/', 'https://example.com/a']);
  });

  it('emits NO priority and NO changefreq — Google ignores both', () => {
    const out = buildSitemap([page({ path: '/a' })], config);
    expect(out).not.toContain('priority');
    expect(out).not.toContain('changefreq');
  });

  // The rule that keeps a generated sitemap honest: we publish where the crawl
  // actually got a page, and nowhere else.
  it('excludes non-200, errored, and noindexed pages', () => {
    const out = buildSitemap(
      [
        page({ path: '/ok' }),
        page({ path: '/404', status: 404 }),
        page({ path: '/301', status: 301 }),
        page({ path: '/boom', status: 0, error: 'timeout' }),
        page({ path: '/hidden', noindex: 1 }),
        page({ path: '/hidden-bool', noindex: true }),
      ],
      config,
    );
    expect(locs(out)).toEqual(['https://example.com/ok']);
  });

  it('dedupes by path, first occurrence wins', () => {
    expect(locs(buildSitemap([page({ path: '/a' }), page({ path: '/a' })], config))).toEqual(['https://example.com/a']);
  });

  it('normalizes a trailing slash on SITE_URL', () => {
    const out = buildSitemap([page({ path: '/a' })], { siteUrl: 'https://example.com/' });
    expect(locs(out)).toEqual(['https://example.com/a']);
  });

  it('XML-escapes the location', () => {
    const out = buildSitemap([page({ path: '/a?x=1&y=2' })], config);
    expect(out).toContain('<loc>https://example.com/a?x=1&amp;y=2</loc>');
    expect(out).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it('drops paths that could not have come from a URL pathname', () => {
    const out = buildSitemap(
      [
        page({ path: 'a' }), // not root-relative
        page({ path: '/a b' }), // whitespace
        page({ path: '/a\\b' }), // backslash — a separator to a URL parser
        page({ path: '/a\nb' }), // would smuggle a line break into the XML
        page({ path: '/../etc' }),
        page({ path: '//evil.com/x' }),
        page({ path: '/fine' }),
      ],
      config,
    );
    expect(locs(out)).toEqual(['https://example.com/fine']);
  });

  // The central promise: no invented lastmod. In homepage-crawl mode — the only
  // mode that makes a site eligible — every snapshot's lastmod is null, so the
  // file carries none at all rather than today's date on every URL.
  it('omits <lastmod> entirely when the crawl observed none', () => {
    const out = buildSitemap([page({ path: '/a' }), page({ path: '/b' })], config);
    expect(out).not.toContain('lastmod');
  });

  it('emits an OBSERVED lastmod, and only in a shape the protocol accepts', () => {
    const out = buildSitemap(
      [
        page({ path: '/date', lastmod: '2026-08-05' }),
        page({ path: '/stamp', lastmod: '2026-08-05T10:00:00Z' }),
        page({ path: '/junk', lastmod: 'last tuesday' }),
        page({ path: '/empty', lastmod: '' }),
      ],
      config,
    );
    expect(out).toContain('<lastmod>2026-08-05</lastmod>');
    expect(out).toContain('<lastmod>2026-08-05T10:00:00Z</lastmod>');
    expect(out.match(/<lastmod>/g)).toHaveLength(2);
    expect(locs(out)).toHaveLength(4); // the junk lastmod drops the DATE, not the URL
  });

  it('is byte-stable for a stable crawl — a re-run produces no new diff', () => {
    const pages = [page({ path: '/a' }), page({ path: '/b' })];
    expect(buildSitemap(pages, config)).toBe(buildSitemap([...pages], config));
  });

  it('an empty crawl yields an empty urlset, not a broken document', () => {
    expect(buildSitemap([], config)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n',
    );
  });
});

describe('the sitemap_xml resource field', () => {
  it('is pinned to /sitemap.xml with an XML content type', () => {
    expect(fixedResourceSpec('sitemap_xml')).toEqual({ path: '/sitemap.xml', contentType: 'application/xml; charset=utf-8' });
    expect(RESOURCE_FIELDS.has('sitemap_xml')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fakes: enough D1/KV for generate → propose → approve → revert.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Tables = { runs: Row[]; snapshots: Row[]; proposals: Row[]; changes: Row[]; findings: Row[] };

function fakeDb(t: Tables) {
  const run = (sql: string, b: unknown[]) => {
    if (/INSERT INTO proposals/.test(sql)) {
      const [created_at, , path, field, current_value, proposed_value, rationale] = b;
      const row = { id: t.proposals.length + 1, created_at, path, field, current_value, proposed_value, rationale, model: 'manual', status: 'proposed' };
      t.proposals.push(row);
      return { first: row, all: [], meta: {} };
    }
    if (/SELECT id FROM proposals WHERE field = \? AND status = 'proposed'/.test(sql)) {
      return { first: t.proposals.find((p) => p.field === b[0] && p.status === 'proposed') ?? null, all: [], meta: {} };
    }
    if (/SELECT \* FROM proposals WHERE id = \? AND status = 'proposed'/.test(sql)) {
      return { first: t.proposals.find((p) => p.id === b[0] && p.status === 'proposed') ?? null, all: [], meta: {} };
    }
    if (/UPDATE proposals SET status = '(approved|rejected)'/.test(sql)) {
      const status = /'approved'/.test(sql) ? 'approved' : 'rejected';
      const p = t.proposals.find((x) => x.id === b[b.length - 1]);
      if (p) p.status = status;
      return { first: null, all: [], meta: {} };
    }
    if (/UPDATE proposals SET status = 'reverted'/.test(sql)) {
      const c = t.changes.find((x) => x.id === b[0]);
      const p = t.proposals.find((x) => x.id === c?.proposal_id && x.status === 'approved');
      if (p) p.status = 'reverted';
      return { first: null, all: [], meta: {} };
    }
    if (/INSERT INTO changes/.test(sql)) {
      const [applied_at, path, field, old_value, new_value, source, proposal_id] = b;
      const row = { id: t.changes.length + 1, applied_at, path, field, old_value, new_value, source, proposal_id, reverted_at: null };
      t.changes.push(row);
      return { first: row, all: [], meta: {} };
    }
    if (/FROM changes WHERE id = \?/.test(sql)) return { first: t.changes.find((c) => c.id === b[0]) ?? null, all: [], meta: {} };
    if (/SELECT MAX\(id\) AS id FROM changes/.test(sql)) {
      const ids = t.changes.filter((c) => c.path === b[0] && c.field === b[1] && c.reverted_at === null).map((c) => c.id as number);
      return { first: { id: ids.length ? Math.max(...ids) : null }, all: [], meta: {} };
    }
    if (/UPDATE changes SET reverted_at/.test(sql)) {
      const c = t.changes.find((x) => x.id === b[1]);
      if (c) c.reverted_at = b[0];
      return { first: null, all: [], meta: {} };
    }
    if (/FROM findings WHERE rule = 'sitemap_missing' AND status = 'open'/.test(sql)) {
      return { first: t.findings.find((f) => f.rule === 'sitemap_missing' && f.status === 'open') ?? null, all: [], meta: {} };
    }
    if (/FROM crawl_runs WHERE ok = 1/.test(sql)) {
      const ok = t.runs.filter((r) => r.ok === 1);
      return { first: ok.length ? ok[ok.length - 1] : null, all: [], meta: {} };
    }
    if (/FROM page_snapshots WHERE run_id = \?/.test(sql)) {
      return { first: null, all: t.snapshots.filter((s) => s.run_id === b[0]), meta: {} };
    }
    throw new Error(`fakeDb: unhandled statement: ${sql}`);
  };
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    first: async () => run(sql, binds).first,
    all: async () => ({ results: run(sql, binds).all }),
    run: async () => run(sql, binds),
  });
  return { prepare: (sql: string) => stmt(sql) } as any;
}

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as any,
  };
}

/** A site whose own sitemap failed — the only kind that may have a managed one. */
const MISSING = { id: 1, rule: 'sitemap_missing', status: 'open' };

const deps = (t: Partial<Tables> = {}, kvInit?: Record<string, string>) => {
  const tables: Tables = { runs: [], snapshots: [], proposals: [], changes: [], findings: [], ...t };
  const { store, kv } = fakeKv(kvInit);
  return { tables, store, deps: { db: fakeDb(tables), overrides: kv, config } as any };
};

const snaps = (run_id: number, rows: Partial<SitemapPage>[]) => rows.map((r) => ({ run_id, ...page({ path: '/x', ...(r as any) }) }));

// ---------------------------------------------------------------------------

describe('generateSitemap', () => {
  it('reads the latest OK run, never a failed or in-flight one', async () => {
    const d = deps({
      runs: [{ id: 1, ok: 1 }, { id: 2, ok: 0 }, { id: 3, ok: 1 }],
      snapshots: [...snaps(1, [{ path: '/old' }]), ...snaps(3, [{ path: '/new' }])],
    });
    const r = await generateSitemap(d.deps);
    expect(r).toMatchObject({ runId: 3, entries: 1 });
    expect(r.body).toContain('/new');
    expect(r.body).not.toContain('/old');
  });

  it('returns an empty urlset when no crawl has succeeded', async () => {
    const r = await generateSitemap(deps().deps);
    expect(r).toMatchObject({ entries: 0, runId: null });
  });

  it('refuses loudly rather than silently truncating a site too big to publish', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ path: `/${'p'.repeat(60)}-${i}` }));
    const d = deps({ runs: [{ id: 1, ok: 1 }], snapshots: snaps(1, many) });
    const err = await generateSitemap(d.deps).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toMatch(/more pages than we can publish/);
  });
});

describe('createSitemapProposal — origin wins', () => {
  it('REFUSES when the site has no open sitemap_missing finding', async () => {
    const d = deps({ runs: [{ id: 1, ok: 1 }], snapshots: snaps(1, [{ path: '/a' }]) });
    const err = await createSitemapProposal(d.deps).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toMatch(/already serves a sitemap/);
    expect(d.tables.proposals).toHaveLength(0);
  });

  it('REFUSES once the finding has resolved — the site published its own sitemap', async () => {
    const d = deps({
      runs: [{ id: 1, ok: 1 }],
      snapshots: snaps(1, [{ path: '/a' }]),
      findings: [{ ...MISSING, status: 'resolved' }],
    });
    await expect(createSitemapProposal(d.deps)).rejects.toThrow(/already serves a sitemap/);
  });

  it('sitemapProposalBlockedReason agrees with the POST, so a button can gate on it', async () => {
    expect(await sitemapProposalBlockedReason(deps({ findings: [MISSING] }).deps)).toBeNull();
    expect(await sitemapProposalBlockedReason(deps().deps)).toMatch(/already serves a sitemap/);
  });

  it('proposes the generated body with the live KV value as current_value', async () => {
    const live = JSON.stringify({ contentType: 'application/xml; charset=utf-8', body: '<urlset/>' });
    const d = deps(
      { runs: [{ id: 1, ok: 1 }], snapshots: snaps(1, [{ path: '/a' }]), findings: [MISSING] },
      { [resourceKey('/sitemap.xml')]: live },
    );
    expect(await createSitemapProposal(d.deps)).toMatchObject({ ok: true, id: 1, status: 'proposed' });
    expect(d.tables.proposals[0]).toMatchObject({ path: '/sitemap.xml', field: 'sitemap_xml', current_value: '<urlset/>' });
    expect(String(d.tables.proposals[0].proposed_value)).toContain('<loc>https://example.com/a</loc>');
    expect(String(d.tables.proposals[0].rationale)).toBe('generated from the latest crawl (1 page)');
  });

  it('409s rather than publishing an empty urlset — that reads as "deindex me"', async () => {
    const d = deps({ runs: [{ id: 1, ok: 1 }], snapshots: snaps(1, [{ path: '/a', noindex: 1 }]), findings: [MISSING] });
    const err = await createSitemapProposal(d.deps).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toMatch(/no crawled pages to list/);
  });

  it('allows only one open sitemap proposal at a time', async () => {
    const d = deps({ runs: [{ id: 1, ok: 1 }], snapshots: snaps(1, [{ path: '/a' }]), findings: [MISSING] });
    await createSitemapProposal(d.deps);
    await expect(createSitemapProposal(d.deps)).rejects.toThrow(/already awaiting review/);
  });
});

describe('the sitemap rides the ordinary approval lifecycle', () => {
  const BODY = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n';

  it('approving publishes resource:/sitemap.xml with the pinned content type', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/sitemap.xml', field: 'sitemap_xml', value: BODY, currentValue: null }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    expect(JSON.parse(d.store.get(resourceKey('/sitemap.xml'))!)).toEqual({
      contentType: 'application/xml; charset=utf-8',
      body: BODY,
    });
    expect(d.tables.changes[0]).toMatchObject({ path: '/sitemap.xml', field: 'sitemap_xml', old_value: null });
  });

  // The kill switch a customer holds: revert DELETES our key, so the origin's
  // own /sitemap.xml (or its honest 404) is what answers again.
  it('reverting the first publish deletes the key and gives the origin its path back', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/sitemap.xml', field: 'sitemap_xml', value: BODY, currentValue: null }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    expect(await revertById(d.deps, 1)).toMatchObject({ ok: true });
    expect(d.store.has(resourceKey('/sitemap.xml'))).toBe(false);
  });

  it('never restores the ORIGIN snapshot on revert — we only ever unpublish what we published', async () => {
    const d = deps();
    await createProposal(
      d.deps,
      { path: '/sitemap.xml', field: 'sitemap_xml', value: BODY, currentValue: "the origin's own sitemap" },
      () => null,
    );
    await decideProposal(d.deps, 1, 'approve');
    await revertById(d.deps, 1);
    expect(d.store.has(resourceKey('/sitemap.xml'))).toBe(false);
  });

  it('rejects a sitemap_xml proposal aimed at another path', async () => {
    await expect(
      createProposal(deps().deps, { path: '/other.xml', field: 'sitemap_xml', value: BODY }, () => null),
    ).rejects.toThrow(/always published at \/sitemap\.xml/);
  });
});
