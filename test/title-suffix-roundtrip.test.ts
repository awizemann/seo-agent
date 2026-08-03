/**
 * THE TITLE SUFFIX CONTRACT, end to end (audit finding H1, fixed in v1.15.1).
 *
 * Before v1.15.1, three modules assumed the site's edge layer appended
 * TITLE_BRAND_SUFFIX to the stored core. Nothing did: the injector's
 * `setInnerContent(o.title)` REPLACES the origin's whole <title> with the
 * stored string and appends nothing. So drafts stored the core, the injector
 * served the bare core (served titles silently lost their brand suffix), and
 * the verification sense — which expected core + suffix — flagged every drafted
 * title as a false critical `injection_regression`.
 *
 * The fix appends the suffix at APPLY time (`withTitleSuffix`, called from
 * `applyOverride`), so the stored override IS the full served value.
 *
 * This suite walks the whole lane rather than any one seam:
 *   draft → proposal row (CORE) → approve → KV override (CORE + SUFFIX)
 *         → injector serves it → crawl reads it back → verify sense is silent.
 */
import { describe, it, expect } from 'vitest';
import { draftAndCreate } from '../src/propose';
import { decideProposal } from '../src/actions';
import { applyOverride, withTitleSuffix, storedOverrideValue, readOverride } from '../src/overrides';
import { verifyOverrides, listPageOverrides } from '../src/verify';
import { resolveSiteConfig } from '../src/config';
import type { PageSnapshot } from '../src/crawl';

const SUFFIX = ' | Acme';
const cfg = (vars: Record<string, string> = {}) =>
  resolveSiteConfig({ SITE_URL: 'https://example.com', SITE_NAME: 'Acme', TITLE_BRAND_SUFFIX: SUFFIX, ...vars });

/**
 * What the injector actually delivers for a stored value, mirrored from
 * injector/src/index.ts: `setInnerContent` writes the raw string as TEXT, so
 * HTMLRewriter escapes the markup-significant characters. The crawl then reads
 * that raw text back. Nothing else happens to the value — in particular, no
 * suffix is appended, which is the whole point of this file.
 */
const serve = (stored: string): string => stored.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

// --- fakes -------------------------------------------------------------------

type Row = Record<string, unknown>;

function fakeDb(proposals: Row[] = [], changes: Row[] = []) {
  const run = (sql: string, b: unknown[]) => {
    if (/SELECT 1 FROM proposals/.test(sql)) {
      return { first: proposals.find((p) => p.path === b[0] && p.field === b[1] && ['proposed', 'approved'].includes(p.status as string)) ? { 1: 1 } : null };
    }
    if (/INSERT INTO proposals/.test(sql)) {
      const [created_at, finding_id, path, field, current_value, proposed_value, rationale, model] = b;
      const row = { id: proposals.length + 1, created_at, finding_id, path, field, current_value, proposed_value, rationale, model, status: 'proposed' };
      proposals.push(row);
      return { first: row };
    }
    if (/SELECT \* FROM proposals WHERE id = \? AND status = 'proposed'/.test(sql)) {
      return { first: proposals.find((p) => p.id === b[0] && p.status === 'proposed') ?? null };
    }
    if (/UPDATE proposals SET status = '(approved|rejected)'/.test(sql)) {
      const p = proposals.find((x) => x.id === b[b.length - 1]);
      if (p) p.status = /'approved'/.test(sql) ? 'approved' : 'rejected';
      return { first: null };
    }
    if (/INSERT INTO changes/.test(sql)) {
      const [applied_at, path, field, old_value, new_value, source, proposal_id] = b;
      const row = { id: changes.length + 1, applied_at, path, field, old_value, new_value, source, proposal_id, reverted_at: null };
      changes.push(row);
      return { first: row };
    }
    throw new Error(`fakeDb: unhandled statement: ${sql}`);
  };
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    first: async () => run(sql, binds).first,
    all: async () => ({ results: [] }),
    run: async () => run(sql, binds),
  });
  return { proposals, changes, db: { prepare: (sql: string) => stmt(sql) } as any };
}

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async ({ prefix }: { prefix: string; limit?: number; cursor?: string }) => ({
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })),
        list_complete: true,
        cursor: undefined,
      }),
    } as any,
  };
}

/** An AI double that returns one scripted draft. */
const scriptedAi = (out: string) => ({ run: async () => ({ response: out }) }) as any;

// -----------------------------------------------------------------------------

describe('title suffix contract — draft → approve → serve → verify (audit H1)', () => {
  const CORE = 'Pricing and plans for content teams';

  it('round-trips: proposal keeps the core, KV holds core+suffix, verify is silent', async () => {
    const { db, proposals } = fakeDb();
    const { kv } = fakeKv();
    const config = cfg();
    const deps = { db, overrides: kv, ai: scriptedAi(CORE), config } as any;

    // 1. Draft a long_title fix. The PROPOSAL stores the CORE — that is what a
    //    reviewer reads and judges.
    const drafted = await draftAndCreate(deps, {
      findingId: 1,
      path: '/p',
      rule: 'long_title',
      field: 'title',
      title: 'An old title that ran on far too long for any search result to show',
      current: 'An old title that ran on far too long for any search result to show',
      description: 'What the plans cost.',
      detail: null,
    } as any);
    expect(drafted).toMatchObject({ created: true, proposalId: 1, autoApplied: false });
    expect(proposals[0].proposed_value).toBe(CORE);
    expect(proposals[0].proposed_value).not.toContain(SUFFIX);

    // 2. Approve it. The OVERRIDE that lands in KV is the FULL served value.
    await decideProposal(deps, 1, 'approve');
    const stored = await readOverride(deps, '/p');
    expect(stored.title).toBe(`${CORE}${SUFFIX}`);
    // The proposal row is untouched by the append.
    expect(proposals[0].proposed_value).toBe(CORE);

    // 3. The injector serves exactly that string (nothing appends a suffix).
    const delivered = serve(stored.title);
    expect(delivered).toBe(`${CORE}${SUFFIX}`);

    // 4. The verification sense reads KV + the crawl and stays silent.
    const entries = await listPageOverrides(deps);
    expect(entries).toEqual([{ path: '/p', title: `${CORE}${SUFFIX}`, description: undefined }]);
    expect(verifyOverrides(entries, [snap({ path: '/p', title: delivered })])).toEqual([]);
  });

  it('the pre-fix behaviour would now be caught: a bare core in KV, served bare, is what a stale deploy looks like', async () => {
    // Storing the core WITHOUT the suffix (what v1.15.0 did) is silent here —
    // the sense compares verbatim — but the served title has lost the brand,
    // which is exactly the regression the fix removes at the source.
    const entries = [{ path: '/p', title: CORE }];
    expect(verifyOverrides(entries, [snap({ path: '/p', title: serve(CORE) })])).toEqual([]);
    expect(withTitleSuffix(CORE, SUFFIX)).toBe(`${CORE}${SUFFIX}`);
  });

  it('approval appends the CURRENT suffix when it changed between draft and approval', async () => {
    const { db, proposals } = fakeDb();
    const { kv } = fakeKv();
    const drafting = { db, overrides: kv, ai: scriptedAi(CORE), config: cfg() } as any;
    await draftAndCreate(drafting, {
      findingId: 1, path: '/p', rule: 'long_title', field: 'title',
      title: 'old', current: 'old', description: null, detail: null,
    } as any);
    expect(proposals[0].proposed_value).toBe(CORE);

    // The operator changes TITLE_BRAND_SUFFIX, then approves the pending draft.
    const approving = { db, overrides: kv, config: cfg({ TITLE_BRAND_SUFFIX: ' — Acme Corp' }) } as any;
    await decideProposal(approving, 1, 'approve');
    expect((await readOverride(approving, '/p')).title).toBe(`${CORE} — Acme Corp`);
  });

  it('never doubles: a value already ending with the suffix is stored as-is', async () => {
    const { db, changes } = fakeDb();
    const { kv } = fakeKv();
    const deps = { db, overrides: kv, config: cfg() } as any;
    await applyOverride(deps, { path: '/p', field: 'title', value: `Pricing${SUFFIX}`, oldValue: null, source: 'test' });
    expect((await readOverride(deps, '/p')).title).toBe(`Pricing${SUFFIX}`);
    // The journal records the value that actually went live, not the argument.
    expect(changes[0].new_value).toBe(`Pricing${SUFFIX}`);
    // Applying twice is idempotent on the suffix.
    await applyOverride(deps, { path: '/p', field: 'title', value: 'Pricing', oldValue: null, source: 'test' });
    expect((await readOverride(deps, '/p')).title).toBe(`Pricing${SUFFIX}`);
  });

  it('no suffix configured: the value is stored exactly as approved', async () => {
    const { db } = fakeDb();
    const { kv } = fakeKv();
    const deps = { db, overrides: kv, config: resolveSiteConfig({ SITE_URL: 'https://example.com' }) } as any;
    await applyOverride(deps, { path: '/p', field: 'title', value: 'Pricing', oldValue: null, source: 'test' });
    expect((await readOverride(deps, '/p')).title).toBe('Pricing');
  });

  it('descriptions never get the suffix', async () => {
    const { db } = fakeDb();
    const { kv } = fakeKv();
    const deps = { db, overrides: kv, config: cfg() } as any;
    const copy = 'A plainly written description that sits comfortably inside the usual length band for a search result.';
    await applyOverride(deps, { path: '/p', field: 'description', value: copy, oldValue: null, source: 'test' });
    expect((await readOverride(deps, '/p')).description).toBe(copy);
  });

  it('a host writing overrides itself can reuse the same rule', () => {
    expect(storedOverrideValue('title', 'Pricing', SUFFIX)).toBe(`Pricing${SUFFIX}`);
    expect(storedOverrideValue('title', `Pricing${SUFFIX}`, SUFFIX)).toBe(`Pricing${SUFFIX}`);
    expect(storedOverrideValue('title', 'Pricing', '')).toBe('Pricing');
    expect(storedOverrideValue('description', 'Pricing', SUFFIX)).toBe('Pricing');
  });

  // Audit M4: entities survive the round trip in BOTH lanes.
  it('entity round trip: a stored literal entity is not a regression, in either lane', async () => {
    const { db } = fakeDb();
    const { kv } = fakeKv();
    const deps = { db, overrides: kv, config: cfg() } as any;
    // An operator-supplied title containing a literal "&amp;" (nine characters).
    await applyOverride(deps, { path: '/p', field: 'title', value: 'Tips &amp; Tricks', oldValue: null, source: 'test' });
    await applyOverride(deps, { path: '/p', field: 'description', value: 'Tools & Toys, "quoted".', oldValue: null, source: 'test' });
    const stored = await readOverride(deps, '/p');
    expect(stored.title).toBe(`Tips &amp; Tricks${SUFFIX}`);

    const entries = await listPageOverrides(deps);
    const delivered = snap({ path: '/p', title: serve(stored.title), description: serve(stored.description) });
    // The delivered title is DOUBLE-escaped ("&amp;amp;") — one decode of the
    // delivered side recovers the stored string, which is why the comparison
    // decodes one side only.
    expect(delivered.title).toBe(`Tips &amp;amp; Tricks${SUFFIX}`);
    expect(verifyOverrides(entries, [delivered])).toEqual([]);
  });

  it('a real injection regression still fires through the whole lane', async () => {
    const { db } = fakeDb();
    const { kv } = fakeKv();
    const deps = { db, overrides: kv, config: cfg() } as any;
    await applyOverride(deps, { path: '/p', field: 'title', value: CORE, oldValue: null, source: 'test' });
    const entries = await listPageOverrides(deps);
    // The origin's own title is served — the injector never ran.
    const t = verifyOverrides(entries, [snap({ path: '/p', title: 'Origin Title' })]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ rule: 'injection_regression', severity: 'critical' });
    expect(t[0].detail).toContain(`${CORE}${SUFFIX}`);
  });
});
