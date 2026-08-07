import { describe, it, expect } from 'vitest';
import { buildLlmsTxt, generateLlmsTxt, createLlmsTxtProposal, LLMS_TXT_MAX_ENTRIES, type LlmsTxtPage, type LlmsTxtConfig } from '../src/llmstxt';
import { createProposal, decideProposal, revertById, ApiError } from '../src/actions';
import { resourceKey, readResource } from '../src/overrides';

// ---------------------------------------------------------------------------
// buildLlmsTxt — pure, no fakes needed.
// ---------------------------------------------------------------------------

const config: LlmsTxtConfig = {
  siteUrl: 'https://example.com',
  siteName: 'Example',
  siteDescription: 'A site about examples.',
  articlePathPrefix: '/articles/',
};

const page = (p: Partial<LlmsTxtPage> & { path: string }): LlmsTxtPage => ({
  title: 'T',
  description: null,
  noindex: 0,
  status: 200,
  error: null,
  ...p,
});

describe('buildLlmsTxt', () => {
  it('renders the header, the site description and one entry per page', () => {
    const out = buildLlmsTxt([page({ path: '/a', title: 'Alpha', description: 'About alpha.' })], config);
    expect(out).toBe('# Example\n> A site about examples.\n\n## Pages\n- [Alpha](https://example.com/a): About alpha.\n');
  });

  it('omits the blockquote when the site description is empty', () => {
    const out = buildLlmsTxt([page({ path: '/a', title: 'Alpha' })], { ...config, siteDescription: '' });
    expect(out.split('\n')[1]).toBe('');
    expect(out).not.toContain('>');
  });

  it('omits ": description" when the page has none', () => {
    const out = buildLlmsTxt([page({ path: '/a', title: 'Alpha', description: '   ' })], config);
    expect(out).toContain('- [Alpha](https://example.com/a)\n');
  });

  it('skips noindexed, non-200 and errored rows', () => {
    const out = buildLlmsTxt(
      [
        page({ path: '/keep', title: 'Keep' }),
        page({ path: '/noindex', title: 'No', noindex: 1 }),
        page({ path: '/noindex-bool', title: 'No', noindex: true }),
        page({ path: '/redirect', title: 'No', status: 301 }),
        page({ path: '/gone', title: 'No', status: 404 }),
        page({ path: '/boom', title: 'No', status: 0, error: 'timeout' }),
        page({ path: '/odd', title: 'No', status: 200, error: 'partial read' }),
      ],
      config
    );
    expect(out.match(/^- \[/gm)).toHaveLength(1);
    expect(out).toContain('/keep');
  });

  it('caps at 200 entries', () => {
    const many = Array.from({ length: 250 }, (_, i) => page({ path: `/p${i}`, title: `P${i}` }));
    expect(buildLlmsTxt(many, config).match(/^- \[/gm)).toHaveLength(200);
  });

  it('lists articlePathPrefix pages first, each group in input order', () => {
    const out = buildLlmsTxt(
      [
        page({ path: '/about', title: 'About' }),
        page({ path: '/articles/one', title: 'One' }),
        page({ path: '/contact', title: 'Contact' }),
        page({ path: '/articles/two', title: 'Two' }),
      ],
      config
    );
    expect(out.match(/^- \[.*$/gm)?.map((l) => l.match(/\((.*)\)/)?.[1])).toEqual([
      'https://example.com/articles/one',
      'https://example.com/articles/two',
      'https://example.com/about',
      'https://example.com/contact',
    ]);
  });

  it('keeps plain input order when no article prefix is configured', () => {
    const out = buildLlmsTxt(
      [page({ path: '/b', title: 'B' }), page({ path: '/articles/a', title: 'A' })],
      { ...config, articlePathPrefix: '' }
    );
    expect(out.indexOf('/b)')).toBeLessThan(out.indexOf('/articles/a)'));
  });

  it('prefers articles even when the cap truncates the list', () => {
    const pages = [
      ...Array.from({ length: 199 }, (_, i) => page({ path: `/p${i}`, title: `P${i}` })),
      page({ path: '/articles/late', title: 'Late' }),
    ];
    expect(buildLlmsTxt(pages, config)).toContain('/articles/late');
  });

  it('flattens newlines and escapes markdown-breaking brackets in titles', () => {
    const out = buildLlmsTxt(
      [page({ path: '/a', title: 'Odd ] title\nsecond [line]', description: 'Line one\n\nline two.' })],
      config
    );
    expect(out).toContain('- [Odd \\] title second \\[line\\]](https://example.com/a): Line one line two.');
    expect(out.match(/^- \[/gm)).toHaveLength(1); // still exactly one line
  });

  it('falls back to the path when a page delivered no title', () => {
    expect(buildLlmsTxt([page({ path: '/untitled', title: null })], config)).toContain('- [/untitled](https://example.com/untitled)');
  });

  it('does not double the slash when SITE_URL has a trailing one', () => {
    const out = buildLlmsTxt([page({ path: '/a', title: 'A' })], { ...config, siteUrl: 'https://example.com/' });
    expect(out).toContain('(https://example.com/a)');
  });

  it('dedupes repeated paths, keeping the first', () => {
    const out = buildLlmsTxt([page({ path: '/a', title: 'First' }), page({ path: '/a', title: 'Second' })], config);
    expect(out.match(/^- \[/gm)).toHaveLength(1);
    expect(out).toContain('First');
  });

  it('clips a runaway title and description so one page cannot blow the size cap', () => {
    const out = buildLlmsTxt([page({ path: '/a', title: 'T'.repeat(500), description: 'D'.repeat(5000) })], config);
    const entry = out.split('\n').find((l) => l.startsWith('- ['))!;
    expect(entry.match(/\[(T+)\]/)?.[1]).toHaveLength(120);
    expect(entry.split(': ')[1]).toHaveLength(200);
  });

  it('stays under the resource size cap at full width', () => {
    // 200 entries of maximally long text — the worst case a real crawl can feed it.
    const many = Array.from({ length: LLMS_TXT_MAX_ENTRIES }, (_, i) =>
      page({ path: `/${'p'.repeat(80)}${i}`, title: 'T'.repeat(500), description: 'D'.repeat(5000) })
    );
    expect(buildLlmsTxt(many, config).length).toBeLessThan(100_000);
  });

  it('emits a header-only body when nothing is indexable', () => {
    expect(buildLlmsTxt([], config)).toBe('# Example\n> A site about examples.\n\n## Pages\n');
  });
});

// ---------------------------------------------------------------------------
// Fakes: just enough D1 and KV for the proposal → approve → revert path.
// The D1 fake routes on the statement text of the queries these actions issue;
// anything unrecognized throws, so a changed query fails loudly rather than
// silently returning nothing.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Tables = { runs: Row[]; snapshots: Row[]; proposals: Row[]; changes: Row[] };

function fakeDb(t: Tables) {
  const run = (sql: string, b: unknown[]) => {
    if (/INSERT INTO proposals/.test(sql)) {
      const [created_at, path, field, current_value, proposed_value, rationale] = b;
      const row = {
        id: t.proposals.length + 1,
        created_at,
        path,
        field,
        current_value,
        proposed_value,
        rationale,
        model: 'manual',
        status: 'proposed',
      };
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
    if (/FROM changes WHERE id = \?/.test(sql)) {
      return { first: t.changes.find((c) => c.id === b[0]) ?? null, all: [], meta: {} };
    }
    if (/SELECT MAX\(id\) AS id FROM changes/.test(sql)) {
      const ids = t.changes.filter((c) => c.path === b[0] && c.field === b[1] && c.reverted_at === null).map((c) => c.id as number);
      return { first: { id: ids.length ? Math.max(...ids) : null }, all: [], meta: {} };
    }
    if (/UPDATE changes SET reverted_at/.test(sql)) {
      const c = t.changes.find((x) => x.id === b[1]);
      if (c) c.reverted_at = b[0];
      return { first: null, all: [], meta: {} };
    }
    if (/FROM crawl_runs WHERE ok = 1/.test(sql)) {
      const ok = t.runs.filter((r) => r.ok === 1);
      return { first: ok.length ? ok[ok.length - 1] : null, all: [], meta: {} };
    }
    if (/FROM page_snapshots WHERE run_id = \?/.test(sql)) {
      return { first: null, all: t.snapshots.filter((s) => s.run_id === b[0]), meta: {} };
    }
    if (/SELECT title, description(?:, canonical)? FROM page_snapshots WHERE path = \?/.test(sql)) {
      return { first: t.snapshots.find((s) => s.path === b[0]) ?? null, all: [], meta: {} };
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

const deps = (t: Partial<Tables> = {}, kvInit?: Record<string, string>) => {
  const tables: Tables = { runs: [], snapshots: [], proposals: [], changes: [], ...t };
  const { store, kv } = fakeKv(kvInit);
  return { tables, store, deps: { db: fakeDb(tables), overrides: kv, config } as any };
};

const BODY = '# Example\n\n## Pages\n- [A](https://example.com/a)\n';

// ---------------------------------------------------------------------------

describe('createProposal — llms_txt field gate', () => {
  it('accepts a body and stores the caller-supplied current value', async () => {
    const d = deps();
    const r = await createProposal(
      d.deps,
      { path: '/llms.txt', field: 'llms_txt', value: BODY, currentValue: 'old body' },
      () => null
    );
    expect(r).toMatchObject({ ok: true, id: 1, status: 'proposed' });
    expect(d.tables.proposals[0]).toMatchObject({ field: 'llms_txt', path: '/llms.txt', current_value: 'old body', proposed_value: BODY });
  });

  it('409s on a second proposal for the same file while one is awaiting review', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY }, () => null);
    await expect(createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY + '- [B](x)\n' }, () => null))
      .rejects.toThrow(/already awaiting review/);
    expect(d.tables.proposals).toHaveLength(1);
  });

  it('rejects a blank body', async () => {
    await expect(createProposal(deps().deps, { path: '/llms.txt', field: 'llms_txt', value: '   \n ' }, () => null)).rejects.toThrow(
      /empty after trimming/
    );
  });

  it('rejects a body over 100_000 chars', async () => {
    const err = await createProposal(deps().deps, { path: '/llms.txt', field: 'llms_txt', value: 'a'.repeat(100_001) }, () => null).catch(
      (e) => e as ApiError
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/too long/);
  });

  it('accepts a body of exactly 100_000 chars', async () => {
    const r = await createProposal(deps().deps, { path: '/llms.txt', field: 'llms_txt', value: 'a'.repeat(100_000) }, () => null);
    expect(r.ok).toBe(true);
  });

  it('rejects an llms_txt proposal aimed at another path', async () => {
    await expect(createProposal(deps().deps, { path: '/other.txt', field: 'llms_txt', value: BODY }, () => null)).rejects.toThrow(
      /always published at \/llms\.txt/
    );
  });

  it('still rejects an unknown field', async () => {
    await expect(createProposal(deps().deps, { path: '/a', field: 'og_image', value: BODY }, () => null)).rejects.toThrow(
      /field must be one of: description, title, jsonld, canonical/
    );
  });
});

describe('decideProposal — approving an llms_txt proposal', () => {
  it('writes the resource key and journals the prior body as old_value', async () => {
    const prior = JSON.stringify({ contentType: 'text/markdown; charset=utf-8', body: 'previous body' });
    const d = deps({}, { [resourceKey('/llms.txt')]: prior });
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY, currentValue: 'previous body' }, () => null);

    const r = await decideProposal(d.deps, 1, 'approve');
    expect(r).toMatchObject({ ok: true, status: 'approved', changeId: 1 });
    expect(JSON.parse(d.store.get('resource:/llms.txt')!)).toEqual({ contentType: 'text/markdown; charset=utf-8', body: BODY });
    expect(d.tables.changes[0]).toMatchObject({ path: '/llms.txt', field: 'llms_txt', old_value: 'previous body', new_value: BODY });
    // No page override key is touched.
    expect(d.store.has('override:/llms.txt')).toBe(false);
  });

  it('journals old_value = null on the first publish', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY, currentValue: null }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    expect(d.tables.changes[0].old_value).toBeNull();
  });

  it('prefers the LIVE body over the proposal snapshot as old_value', async () => {
    // A second approval between crawls: KV already holds a newer body than the
    // one captured when this proposal was drafted.
    const live = JSON.stringify({ contentType: 'text/markdown; charset=utf-8', body: 'live body' });
    const d = deps({}, { [resourceKey('/llms.txt')]: live });
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY, currentValue: 'stale snapshot' }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    expect(d.tables.changes[0].old_value).toBe('live body');
  });

  it('journals old_value = null when the ORIGIN had a file but we had published nothing', async () => {
    // current_value is a snapshot of the origin's own /llms.txt — a body we
    // never published and cannot restore. Journalling it would make revert pin
    // a frozen copy instead of handing the path back to the origin.
    const d = deps();
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY, currentValue: 'the origin\'s own file' }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    expect(d.tables.changes[0].old_value).toBeNull();
  });

  it('rejects without touching KV', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY }, () => null);
    expect(await decideProposal(d.deps, 1, 'reject')).toMatchObject({ ok: true, status: 'rejected' });
    expect(d.store.size).toBe(0);
    expect(d.tables.changes).toHaveLength(0);
  });
});

describe('revertById — llms_txt changes', () => {
  it('restores the prior body', async () => {
    const prior = JSON.stringify({ contentType: 'text/markdown; charset=utf-8', body: 'previous body' });
    const d = deps({}, { [resourceKey('/llms.txt')]: prior });
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY, currentValue: 'previous body' }, () => null);
    await decideProposal(d.deps, 1, 'approve');

    expect(await revertById(d.deps, 1)).toEqual({ ok: true });
    expect(await readResource(d.deps, '/llms.txt')).toBe('previous body');
    expect(JSON.parse(d.store.get('resource:/llms.txt')!).contentType).toBe('text/markdown; charset=utf-8');
    expect(d.tables.changes[0].reverted_at).toBeTruthy();
    expect(d.tables.proposals[0].status).toBe('reverted');
  });

  it('deletes the key when nothing was published before', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY, currentValue: null }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    await revertById(d.deps, 1);
    expect(d.store.has('resource:/llms.txt')).toBe(false);
  });

  it('deletes the key on revert of a FIRST publish over an origin-served file', async () => {
    // The origin serves its own /llms.txt; we publish over it once, then revert.
    // Correct end state is our key GONE, so the origin serves again — not a
    // pinned copy of whatever the origin happened to serve at proposal time.
    const d = deps();
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY, currentValue: 'origin body' }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    await revertById(d.deps, 1);
    expect(d.store.has('resource:/llms.txt')).toBe(false);
  });

  it('restores the first published body when the second publish is reverted', async () => {
    // Two approvals, no revert in between: the first body IS ours, so reverting
    // the newer change must put it back rather than delete the key.
    const d = deps();
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY, currentValue: null }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    const second = BODY + '- [B](x)\n';
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: second }, () => null);
    await decideProposal(d.deps, 2, 'approve');
    await revertById(d.deps, 2);
    expect(JSON.parse(d.store.get('resource:/llms.txt')!).body).toBe(BODY);
  });

  it('refuses to revert an older change when a newer one is live', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY, currentValue: null }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    await createProposal(d.deps, { path: '/llms.txt', field: 'llms_txt', value: BODY + '- [B](x)\n' }, () => null);
    await decideProposal(d.deps, 2, 'approve');
    await expect(revertById(d.deps, 1)).rejects.toThrow(/newer un-reverted change/);
  });
});

describe('generateLlmsTxt / createLlmsTxtProposal', () => {
  const snaps = (run_id: number, rows: Partial<LlmsTxtPage>[]) =>
    rows.map((r) => ({ run_id, ...page({ path: '/x', ...r } as any) }));

  it('reads the latest OK run', async () => {
    const d = deps({
      runs: [
        { id: 1, ok: 1 },
        { id: 2, ok: 0 }, // still running / failed — must not be used
        { id: 3, ok: 1 },
      ],
      snapshots: [...snaps(1, [{ path: '/old', title: 'Old' }]), ...snaps(3, [{ path: '/new', title: 'New' }])],
    });
    const r = await generateLlmsTxt(d.deps);
    expect(r.runId).toBe(3);
    expect(r.entries).toBe(1);
    expect(r.body).toContain('/new');
    expect(r.body).not.toContain('/old');
  });

  it('returns zero entries when no crawl has succeeded', async () => {
    const r = await generateLlmsTxt(deps().deps);
    expect(r).toMatchObject({ entries: 0, runId: null });
    expect(r.body).toBe('# Example\n> A site about examples.\n\n## Pages\n');
  });

  // BANNED_TERMS on derived content: nothing here was written by a model, so
  // there is no retry that could fix it — the only honest outcome is a 409
  // naming the term and the page it came from.
  const banned = (d: any, terms: string[]) => ({ ...d, config: { ...config, bannedTerms: terms } });

  it('409s when a page title puts a banned term into the generated body', async () => {
    const d = deps({ runs: [{ id: 1, ok: 1 }], snapshots: snaps(1, [{ path: '/a', title: 'The Widgetron Guide' }]) });
    const err = await generateLlmsTxt(banned(d.deps, ['Widgetron'])).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe(
      'generated llms.txt contains banned term "Widgetron" (from your page content) — fix the source page or remove the term'
    );
  });

  it('409s from a page description too, and blocks the proposal entirely', async () => {
    const d = deps({ runs: [{ id: 1, ok: 1 }], snapshots: snaps(1, [{ path: '/a', title: 'A', description: 'Best in class widgets.' }]) });
    await expect(createLlmsTxtProposal(banned(d.deps, ['best in class']))).rejects.toThrow(/banned term "best in class"/);
    expect(d.tables.proposals).toHaveLength(0);
  });

  it('does not fire on a mere substring — the same word boundary as drafts', async () => {
    const d = deps({ runs: [{ id: 1, ok: 1 }], snapshots: snaps(1, [{ path: '/a', title: 'How we maintain the index' }]) });
    const r = await generateLlmsTxt(banned(d.deps, ['AI']));
    expect(r.entries).toBe(1);
  });

  it('creates a proposal carrying the generated body and the live current value', async () => {
    const live = JSON.stringify({ contentType: 'text/markdown; charset=utf-8', body: 'live body' });
    const d = deps({ runs: [{ id: 1, ok: 1 }], snapshots: snaps(1, [{ path: '/a', title: 'A' }]) }, { [resourceKey('/llms.txt')]: live });
    expect(await createLlmsTxtProposal(d.deps)).toMatchObject({ ok: true, id: 1, status: 'proposed' });
    expect(d.tables.proposals[0]).toMatchObject({ path: '/llms.txt', field: 'llms_txt', current_value: 'live body' });
    expect(String(d.tables.proposals[0].proposed_value)).toContain('- [A](https://example.com/a)');
  });

  it('409s when the crawl indexed nothing', async () => {
    const d = deps({ runs: [{ id: 1, ok: 1 }], snapshots: snaps(1, [{ path: '/a', title: 'A', noindex: 1 }]) });
    const err = await createLlmsTxtProposal(d.deps).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
  });
});
