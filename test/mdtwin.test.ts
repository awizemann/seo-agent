import { describe, it, expect } from 'vitest';
import { createProposal, decideProposal, revertById, ApiError } from '../src/actions';
import {
  RESOURCE_FIELDS,
  isPatternSpec,
  fixedResourceSpec,
  resourcePathFor,
  mdTwinPath,
  mdTwinPathReason,
  resourceKey,
  readResource,
} from '../src/overrides';

// ---------------------------------------------------------------------------
// mdTwinPath — the derivation rule, pure. The proxy injector mirrors it
// (twinPath in injector/src/index.ts); these cases pin both.
// ---------------------------------------------------------------------------

describe('mdTwinPath', () => {
  it.each([
    ['/', '/index.md'],
    ['/about', '/about.md'],
    ['/about/', '/about/index.md'],
    ['/articles/deep/one', '/articles/deep/one.md'],
    ['/articles/deep/one/', '/articles/deep/one/index.md'],
    ['/a.b', '/a.b.md'],
  ])('%s → %s', (page, twin) => {
    expect(mdTwinPathReason(page)).toBeNull();
    expect(mdTwinPath(page)).toBe(twin);
  });

  it.each([
    ['', 'empty path'],
    ['about', 'root-relative'],
    ['/a?x=1', 'query string or fragment'],
    ['/a#frag', 'query string or fragment'],
    ['/../etc/passwd', '".."'],
    ['/a/../b', '".."'],
    ['/a//b', 'empty segment'],
    ['/a.md', 'already a .md file'],
    ['/a.MD', 'already a .md file'],
  ])('rejects %s', (page, reason) => {
    expect(mdTwinPathReason(page)).toMatch(reason);
    expect(() => mdTwinPath(page)).toThrow(/invalid md_twin path/);
  });
});

describe('RESOURCE_FIELDS', () => {
  it('keeps the fixed entries fixed and pins their paths', () => {
    expect(fixedResourceSpec('llms_txt')).toEqual({ path: '/llms.txt', contentType: 'text/markdown; charset=utf-8' });
    expect(fixedResourceSpec('llms_full_txt')).toEqual({ path: '/llms-full.txt', contentType: 'text/markdown; charset=utf-8' });
    expect(fixedResourceSpec('robots_txt')).toEqual({ path: '/robots.txt', contentType: 'text/plain; charset=utf-8' });
  });

  it('exposes md_twin as a pattern field', () => {
    const spec = RESOURCE_FIELDS.get('md_twin')!;
    expect(isPatternSpec(spec)).toBe(true);
    expect(spec.contentType).toBe('text/markdown; charset=utf-8');
    expect(resourcePathFor(spec, '/a/b')).toBe('/a/b.md');
    expect(() => fixedResourceSpec('md_twin')).toThrow(/not a fixed resource/);
  });

  it('resourcePathFor ignores the argument for a fixed field', () => {
    expect(resourcePathFor(fixedResourceSpec('robots_txt'), '/anything')).toBe('/robots.txt');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle fakes — the same shape the llms.txt suite uses, plus the
// per-(field, path) open-proposal query a pattern field needs.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Tables = { snapshots: Row[]; proposals: Row[]; changes: Row[] };

function fakeDb(t: Tables) {
  const run = (sql: string, b: unknown[]) => {
    if (/INSERT INTO proposals/.test(sql)) {
      const [created_at, , path, field, current_value, proposed_value, rationale] = b;
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
    if (/SELECT id FROM proposals WHERE field = \? AND path = \? AND status = 'proposed'/.test(sql)) {
      return { first: t.proposals.find((p) => p.field === b[0] && p.path === b[1] && p.status === 'proposed') ?? null, all: [], meta: {} };
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
    if (/SELECT title, description\b.* FROM page_snapshots WHERE path = \?/.test(sql)) {
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

const deps = (kvInit?: Record<string, string>) => {
  const tables: Tables = { snapshots: [], proposals: [], changes: [] };
  const { store, kv } = fakeKv(kvInit);
  return { tables, store, deps: { db: fakeDb(tables), overrides: kv } as any };
};

const TWIN = '# Alpha\n\nBody of the page, in markdown.\n';

describe('createProposal — md_twin field gate', () => {
  it('accepts a page path and stores the caller-supplied current value', async () => {
    const d = deps();
    const r = await createProposal(d.deps, { path: '/articles/a', field: 'md_twin', value: TWIN, currentValue: null }, () => null);
    expect(r).toMatchObject({ ok: true, id: 1, status: 'proposed' });
    // The PROPOSAL carries the page path; the twin path is derived at apply.
    expect(d.tables.proposals[0]).toMatchObject({ field: 'md_twin', path: '/articles/a', proposed_value: TWIN });
  });

  it('rejects a path that is not a clean page path', async () => {
    for (const path of ['/a/../b', '/a?x=1', '/a.md', 'a']) {
      const err = await createProposal(deps().deps, { path, field: 'md_twin', value: TWIN }, () => null).catch((e) => e as ApiError);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/invalid path for md_twin/);
    }
  });

  it('rejects a blank body', async () => {
    await expect(createProposal(deps().deps, { path: '/a', field: 'md_twin', value: '  \n ' }, () => null)).rejects.toThrow(
      /empty after trimming/
    );
  });

  it('rejects a body over 100_000 chars and accepts exactly 100_000', async () => {
    const err = await createProposal(deps().deps, { path: '/a', field: 'md_twin', value: 'a'.repeat(100_001) }, () => null).catch(
      (e) => e as ApiError
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/too long/);
    expect((await createProposal(deps().deps, { path: '/a', field: 'md_twin', value: 'a'.repeat(100_000) }, () => null)).ok).toBe(true);
  });

  it('409s on a second open proposal for the SAME page', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/a', field: 'md_twin', value: TWIN }, () => null);
    await expect(createProposal(d.deps, { path: '/a', field: 'md_twin', value: TWIN + 'more' }, () => null)).rejects.toThrow(
      /already awaiting review/
    );
    expect(d.tables.proposals).toHaveLength(1);
  });

  it('allows open proposals for DIFFERENT pages at the same time', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/a', field: 'md_twin', value: TWIN }, () => null);
    await createProposal(d.deps, { path: '/b', field: 'md_twin', value: TWIN }, () => null);
    expect(d.tables.proposals).toHaveLength(2);
  });
});

describe('decideProposal / revertById — md_twin round-trip', () => {
  it('approving writes resource:<page>.md and journals the derived path', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/articles/a', field: 'md_twin', value: TWIN, currentValue: null }, () => null);
    const r = await decideProposal(d.deps, 1, 'approve');

    expect(r).toMatchObject({ ok: true, status: 'approved', changeId: 1 });
    expect(JSON.parse(d.store.get('resource:/articles/a.md')!)).toEqual({
      contentType: 'text/markdown; charset=utf-8',
      body: TWIN,
    });
    expect(d.tables.changes[0]).toMatchObject({ path: '/articles/a.md', field: 'md_twin', old_value: null, new_value: TWIN });
    expect(d.store.has('override:/articles/a')).toBe(false);
  });

  it('derives index.md for a trailing-slash page path', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/section/', field: 'md_twin', value: TWIN }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    expect(d.store.has('resource:/section/index.md')).toBe(true);
  });

  it('journals the LIVE body, never the origin snapshot', async () => {
    const live = JSON.stringify({ contentType: 'text/markdown; charset=utf-8', body: 'live twin' });
    const d = deps({ [resourceKey('/a.md')]: live });
    await createProposal(d.deps, { path: '/a', field: 'md_twin', value: TWIN, currentValue: "the origin's own twin" }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    expect(d.tables.changes[0].old_value).toBe('live twin');
  });

  it('reverting deletes the key when nothing was published before', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/a', field: 'md_twin', value: TWIN }, () => null);
    await decideProposal(d.deps, 1, 'approve');

    expect(await revertById(d.deps, 1)).toEqual({ ok: true });
    expect(d.store.has('resource:/a.md')).toBe(false);
    expect(d.tables.changes[0].reverted_at).toBeTruthy();
    expect(d.tables.proposals[0].status).toBe('reverted');
  });

  it('reverting restores the body WE published before', async () => {
    const prior = JSON.stringify({ contentType: 'text/markdown; charset=utf-8', body: 'previous twin' });
    const d = deps({ [resourceKey('/a.md')]: prior });
    await createProposal(d.deps, { path: '/a', field: 'md_twin', value: TWIN }, () => null);
    await decideProposal(d.deps, 1, 'approve');

    expect(await revertById(d.deps, 1)).toEqual({ ok: true });
    expect(await readResource(d.deps, '/a.md')).toBe('previous twin');
    expect(JSON.parse(d.store.get('resource:/a.md')!).contentType).toBe('text/markdown; charset=utf-8');
  });

  it('reverts of different pages are independent', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/a', field: 'md_twin', value: 'A twin' }, () => null);
    await createProposal(d.deps, { path: '/b', field: 'md_twin', value: 'B twin' }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    await decideProposal(d.deps, 2, 'approve');

    expect(await revertById(d.deps, 1)).toEqual({ ok: true });
    expect(d.store.has('resource:/a.md')).toBe(false);
    expect(await readResource(d.deps, '/b.md')).toBe('B twin');
  });

  it('rejecting touches nothing', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/a', field: 'md_twin', value: TWIN }, () => null);
    expect(await decideProposal(d.deps, 1, 'reject')).toMatchObject({ ok: true, status: 'rejected' });
    expect(d.store.size).toBe(0);
    expect(d.tables.changes).toHaveLength(0);
  });
});

describe('llms_full_txt — the second fixed markdown file', () => {
  it('publishes at /llms-full.txt and reverts back to the origin', async () => {
    const d = deps();
    await createProposal(d.deps, { path: '/llms-full.txt', field: 'llms_full_txt', value: TWIN, currentValue: null }, () => null);
    await decideProposal(d.deps, 1, 'approve');
    expect(JSON.parse(d.store.get('resource:/llms-full.txt')!)).toEqual({
      contentType: 'text/markdown; charset=utf-8',
      body: TWIN,
    });
    expect(d.tables.changes[0]).toMatchObject({ path: '/llms-full.txt', field: 'llms_full_txt', old_value: null });

    expect(await revertById(d.deps, 1)).toEqual({ ok: true });
    expect(d.store.has('resource:/llms-full.txt')).toBe(false);
  });

  it('rejects a proposal aimed at another path', async () => {
    await expect(createProposal(deps().deps, { path: '/llms.txt', field: 'llms_full_txt', value: TWIN }, () => null)).rejects.toThrow(
      /always published at \/llms-full\.txt/
    );
  });
  // v1.14.1: a backslash resolves as a separator to a URL parser
  // (new URL('/\\evil.com/x', 'https://site.com') → https://evil.com/x), and
  // control characters smuggle line breaks into anything that logs or signs
  // the path. Both belong here, not in each caller's own re-check.
  it('refuses a backslash — it would resolve to a different host', () => {
    expect(mdTwinPathReason('/\\evil.com/x')).toContain('backslash');
    expect(mdTwinPathReason('/a\\b')).toContain('backslash');
    expect(new URL('/\\evil.com/x', 'https://site.com').hostname).toBe('evil.com');
  });

  it('refuses control characters', () => {
    expect(mdTwinPathReason('/a\n')).toContain('control');
    expect(mdTwinPathReason('/a\u0000b')).toContain('control');
    expect(mdTwinPathReason('/a\u007f')).toContain('control');
  });

});
