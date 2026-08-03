import { describe, it, expect } from 'vitest';
import { verifyOverrides, listPageOverrides, overrideVerificationFindings, expectedTitle, normalizeDelivered, truncateValue } from '../src/verify';
import { runRules } from '../src/rules';
import type { PageSnapshot } from '../src/crawl';

const snap = (over: Partial<PageSnapshot> & { path: string }): PageSnapshot => ({
  status: 200,
  title: null,
  description: null,
  canonical: null,
  ogImage: null,
  ogType: null,
  jsonldTypes: [],
  noindex: false,
  lastmod: null,
  error: null,
  ...over,
});

// A KV double with real prefix listing + cursor paging, so the paging path is
// exercised rather than assumed.
function fakeKv(initial: Record<string, string> = {}, pageSize = 1000) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async ({ prefix, cursor }: { prefix: string; limit?: number; cursor?: string }) => {
        const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = cursor ? Number(cursor) : 0;
        const slice = all.slice(start, start + pageSize);
        const next = start + pageSize;
        const complete = next >= all.length;
        return { keys: slice.map((name) => ({ name })), list_complete: complete, cursor: complete ? undefined : String(next) };
      },
    } as any,
  };
}

describe('override verification — pure comparison', () => {
  it('fires injection_regression when the delivered title is not the approved one', () => {
    const t = verifyOverrides([{ path: '/a', title: 'Approved Title' }], [snap({ path: '/a', title: 'Old Origin Title' })], '');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ path: '/a', rule: 'injection_regression', severity: 'critical' });
    expect(t[0].detail).toContain('Approved Title');
    expect(t[0].detail).toContain('Old Origin Title');
    expect(t[0].detail).toContain('title:');
  });

  it('stays silent when the delivered value matches', () => {
    expect(verifyOverrides([{ path: '/a', title: 'Approved Title' }], [snap({ path: '/a', title: 'Approved Title' })], '')).toEqual([]);
  });

  it('expects core + brand suffix when a suffix is configured', () => {
    const entries = [{ path: '/a', title: 'Core' }];
    expect(verifyOverrides(entries, [snap({ path: '/a', title: 'Core — Acme' })], ' — Acme')).toEqual([]);
    // The bare core (no suffix) means the suffixing edge layer never ran.
    const t = verifyOverrides(entries, [snap({ path: '/a', title: 'Core' })], ' — Acme');
    expect(t).toHaveLength(1);
    expect(t[0].detail).toContain('Core — Acme');
  });

  it('does not double-append when the stored core already carries the suffix', () => {
    // That is the doubled_title_suffix bug, which has its own rule — this sense
    // must not blame the injector for it.
    expect(verifyOverrides([{ path: '/a', title: 'Core — Acme' }], [snap({ path: '/a', title: 'Core — Acme' })], ' — Acme')).toEqual([]);
  });

  it('accepts an entity-encoded delivered value (the injector escapes what it writes)', () => {
    expect(verifyOverrides([{ path: '/a', title: 'Tools & Toys' }], [snap({ path: '/a', title: 'Tools &amp; Toys' })], '')).toEqual([]);
    expect(
      verifyOverrides([{ path: '/a', description: 'A "quoted" phrase & more' }], [snap({ path: '/a', description: 'A &quot;quoted&quot; phrase &amp; more' })], '')
    ).toEqual([]);
  });

  it('tolerates whitespace re-wrapping inside the delivered title', () => {
    expect(verifyOverrides([{ path: '/a', title: 'A Long Title' }], [snap({ path: '/a', title: '  A   Long\n  Title ' })], '')).toEqual([]);
  });

  it('compares descriptions directly and names the field', () => {
    const t = verifyOverrides([{ path: '/a', description: 'Approved copy.' }], [snap({ path: '/a', description: 'Origin copy.' })], '');
    expect(t).toHaveLength(1);
    expect(t[0].detail).toMatch(/description: expected "Approved copy\.", delivered "Origin copy\."/);
  });

  it('reports a missing delivered value as "nothing" rather than an empty quote', () => {
    const t = verifyOverrides([{ path: '/a', description: 'Approved copy.' }], [snap({ path: '/a', description: null })], '');
    expect(t[0].detail).toContain('delivered nothing');
  });

  it('reports both fields in one finding for one path', () => {
    const t = verifyOverrides([{ path: '/a', title: 'T', description: 'D' }], [snap({ path: '/a', title: 'x', description: 'y' })], '');
    expect(t).toHaveLength(1);
    expect(t[0].detail).toContain('title:');
    expect(t[0].detail).toContain('description:');
  });

  it('skips non-2xx snapshots — head fields are meaningless there', () => {
    for (const status of [0, 301, 404, 500]) {
      expect(verifyOverrides([{ path: '/a', title: 'T' }], [snap({ path: '/a', status, title: 'wrong' })], '')).toEqual([]);
    }
  });

  it('skips paths not crawled this run — no evidence either way', () => {
    expect(verifyOverrides([{ path: '/gone', title: 'T' }], [snap({ path: '/a', title: 'T' })], '')).toEqual([]);
  });

  it('truncates long values in the detail', () => {
    const long = 'x'.repeat(400);
    const t = verifyOverrides([{ path: '/a', title: long }], [snap({ path: '/a', title: 'short' })], '');
    expect(t[0].detail.length).toBeLessThan(400);
    expect(t[0].detail).toContain('…');
  });
});

describe('override verification — helpers', () => {
  it('expectedTitle appends only when needed', () => {
    expect(expectedTitle('Core', '')).toBe('Core');
    expect(expectedTitle(' Core ', ' | A')).toBe('Core | A');
    expect(expectedTitle('Core | A', ' | A')).toBe('Core | A');
  });
  it('normalizeDelivered decodes entities and folds whitespace', () => {
    expect(normalizeDelivered(' a  &amp;\nb ')).toBe('a & b');
  });
  it('truncateValue keeps short values verbatim', () => {
    expect(truncateValue('  a  b ')).toBe('a b');
  });
});

describe('override verification — KV listing', () => {
  it('reads every page override, ignoring resource keys and junk', async () => {
    const { kv } = fakeKv({
      'override:/a': JSON.stringify({ title: 'T' }),
      'override:/b': JSON.stringify({ description: 'D' }),
      'override:/c': '{not json',
      'override:/d': JSON.stringify({}),
      'resource:/llms.txt': JSON.stringify({ contentType: 'text/markdown', body: '# x' }),
    });
    const entries = await listPageOverrides({ overrides: kv });
    expect(entries.map((e) => e.path).sort()).toEqual(['/a', '/b']);
  });

  it('pages the listing with the cursor until list_complete', async () => {
    const init: Record<string, string> = {};
    for (let i = 0; i < 25; i++) init[`override:/p${String(i).padStart(3, '0')}`] = JSON.stringify({ title: 'T' });
    const { kv } = fakeKv(init, 10); // forces 3 pages
    expect(await listPageOverrides({ overrides: kv })).toHaveLength(25);
  });

  it('skips resource-only key spaces entirely (resource overrides are out of scope)', async () => {
    const { kv } = fakeKv({ 'resource:/robots.txt': JSON.stringify({ contentType: 'text/plain', body: 'x' }) });
    expect(await listPageOverrides({ overrides: kv })).toEqual([]);
  });
});

describe('override verification — sense wiring', () => {
  const config = { titleBrandSuffix: ' — Acme' } as any;

  it('end-to-end: KV + snapshots produce the finding', async () => {
    const { kv } = fakeKv({ 'override:/a': JSON.stringify({ title: 'Core' }) });
    const t = await overrideVerificationFindings({ overrides: kv, config }, [snap({ path: '/a', title: 'Stale' })]);
    expect(t).toHaveLength(1);
    expect(t[0].rule).toBe('injection_regression');
  });

  it('no-ops when the crawl produced no snapshots (no KV read at all)', async () => {
    let listed = false;
    const overrides = { list: async () => ((listed = true), { keys: [], list_complete: true }) } as any;
    expect(await overrideVerificationFindings({ overrides, config }, [])).toEqual([]);
    expect(listed).toBe(false);
  });

  it('a KV failure is isolated by the pipeline sense wrapper — zero findings, no throw', async () => {
    const overrides = {
      list: async () => {
        throw new Error('KV down');
      },
    } as any;
    await expect(overrideVerificationFindings({ overrides, config }, [snap({ path: '/a' })])).rejects.toThrow('KV down');
    // …and the pipeline's `sense` contract swallows exactly that:
    const extra: any[] = [];
    const sense = async (name: string, fn: () => Promise<any[]>) => {
      try {
        extra.push(...(await fn()));
      } catch {
        /* degraded to zero findings */
      }
    };
    await sense('override_verify', () => overrideVerificationFindings({ overrides, config }, [snap({ path: '/a' })]));
    expect(extra).toEqual([]);
  });
});

// --- Dedupe against the shellTitle detector -----------------------------------
// Both detectors emit `injection_regression` for the same path. runRules keys
// triggered findings by (path, rule) and keeps the first occurrence, so exactly
// one row is inserted. This proves it rather than assuming it.
describe('dedupe with the shellTitle injection_regression detector', () => {
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

  it('inserts ONE injection_regression when both senses fire for the same path', async () => {
    const { inserted, db } = fakeDb();
    const config = { siteUrl: 'https://acme.test', shellTitle: 'Acme App', titleBrandSuffix: '', articlePathPrefix: '' } as any;
    // The page serves the SPA shell title while an override approves something else.
    const snapshots = [snap({ path: '/a', title: 'Acme App', description: 'A description that is easily long enough to pass the minimum bound here.', canonical: 'https://acme.test/a', ogImage: 'https://acme.test/i.png' })];
    const { kv } = fakeKv({ 'override:/a': JSON.stringify({ title: 'Approved Title' }) });
    const extra = await overrideVerificationFindings({ overrides: kv, config }, snapshots);
    expect(extra).toHaveLength(1);

    await runRules({ db, config }, 2, snapshots, extra);
    const regressions = inserted.filter((b) => b[3] === 'injection_regression');
    expect(regressions).toHaveLength(1);
    // The verification sense went in first, so its richer detail is what lands.
    expect(regressions[0][5]).toContain('approved override is not being served');
  });
});
