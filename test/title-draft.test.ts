import { describe, it, expect } from 'vitest';
import {
  DESCRIPTION_RULES,
  TITLE_RULES,
  PROPOSABLE_RULES,
  fieldForRule,
  parseTitleDetail,
  dedupeTitleSuffix,
  invalidTitleReason,
  buildTitleSystemPrompt,
  draftWithTrace,
  draftAndCreate,
  RULE_FIELD_SQL,
} from '../src/propose';
import { runRules } from '../src/rules';
import { listFindings, draftFinding } from '../src/actions';
import { resolveSiteConfig } from '../src/config';

const cfg = (vars: Record<string, string> = {}) =>
  resolveSiteConfig({ SITE_URL: 'https://example.com', SITE_NAME: 'Acme', ...vars });
const SUFFIX = ' | Acme';
const branded = (vars: Record<string, string> = {}) => cfg({ TITLE_BRAND_SUFFIX: SUFFIX, ...vars });

// ---------------------------------------------------------------------------
// Rule → field routing.
// ---------------------------------------------------------------------------

describe('fieldForRule', () => {
  it('routes every title rule to the title field', () => {
    for (const r of ['long_title', 'missing_title', 'duplicate_title', 'doubled_title_suffix']) {
      expect(fieldForRule(r)).toBe('title');
    }
  });

  it('routes every description rule to the description field', () => {
    for (const r of ['missing_description', 'short_description', 'long_description', 'truncated_description']) {
      expect(fieldForRule(r)).toBe('description');
    }
  });

  it('answers null for a rule the pipeline cannot fix', () => {
    expect(fieldForRule('sitemap_url_error')).toBeNull();
    expect(fieldForRule('')).toBeNull();
  });

  it('PROPOSABLE_RULES is exactly the union, and the two halves do not overlap', () => {
    expect(PROPOSABLE_RULES.size).toBe(DESCRIPTION_RULES.size + TITLE_RULES.size);
    for (const r of [...DESCRIPTION_RULES, ...TITLE_RULES]) expect(PROPOSABLE_RULES.has(r)).toBe(true);
  });

  it('the candidate query CASE maps the same way the function does', () => {
    for (const r of TITLE_RULES) expect(RULE_FIELD_SQL).toContain(`'${r}'`);
    for (const r of DESCRIPTION_RULES) expect(RULE_FIELD_SQL).not.toContain(`'${r}'`);
  });
});

// ---------------------------------------------------------------------------
// Detail parsing, driven by the REAL details runRules writes. rules.ts is the
// only writer and parseTitleDetail the only reader, so the pair is tested
// end-to-end rather than against a hand-copied format string.
// ---------------------------------------------------------------------------

/** Minimal D1 stand-in: records the findings runRules inserts. */
const rulesDb = () => {
  const inserted: Array<{ path: string; rule: string; severity: string; detail: string }> = [];
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    first: async () => null, // no previous run — no new_page/removed_page events
    all: async () => ({ results: [] }), // nothing open, nothing dismissed
    run: async () => ({}),
    __sql: sql,
    __binds: binds,
  });
  return {
    inserted,
    db: {
      prepare: (sql: string) => stmt(sql),
      batch: async (statements: any[]) => {
        for (const s of statements) {
          if (/INSERT INTO findings/.test(s.__sql)) {
            inserted.push({ path: s.__binds[2], rule: s.__binds[3], severity: s.__binds[4], detail: s.__binds[5] });
          }
        }
        return [];
      },
    },
  };
};

const snap = (path: string, title: string | null, description: string | null = 'x'.repeat(100) + '.') =>
  ({ path, status: 200, title, description }) as any;

const realFindings = async (snapshots: any[], config = branded()) => {
  const { db, inserted } = rulesDb();
  await runRules({ db, config } as any, 2, snapshots);
  return inserted;
};

describe('parseTitleDetail — against the details runRules actually writes', () => {
  it('recovers the title from a long_title detail', async () => {
    const long = 'A very long page title that runs well past the sixty character core bound';
    const f = (await realFindings([snap('/a', long + SUFFIX)])).find((x) => x.rule === 'long_title')!;
    expect(f).toBeDefined();
    expect(parseTitleDetail('long_title', f.detail)).toEqual({ title: long + SUFFIX, duplicatePaths: [] });
  });

  it('recovers the title from a doubled_title_suffix detail', async () => {
    const doubled = `Pricing${SUFFIX}${SUFFIX}`;
    const f = (await realFindings([snap('/p', doubled)])).find((x) => x.rule === 'doubled_title_suffix')!;
    expect(f).toBeDefined();
    expect(parseTitleDetail('doubled_title_suffix', f.detail).title).toBe(doubled);
  });

  it('recovers the sibling paths from a duplicate_title detail', async () => {
    const dupes = await realFindings([snap('/a', 'Home'), snap('/b', 'Home'), snap('/c', 'Home')]);
    const f = dupes.find((x) => x.rule === 'duplicate_title' && x.path === '/a')!;
    expect(f).toBeDefined();
    expect(parseTitleDetail('duplicate_title', f.detail).duplicatePaths).toEqual(['/b', '/c']);
  });

  it('missing_title carries nothing to parse', async () => {
    const f = (await realFindings([snap('/a', null)])).find((x) => x.rule === 'missing_title')!;
    expect(f).toBeDefined();
    expect(parseTitleDetail('missing_title', f.detail)).toEqual({ title: null, duplicatePaths: [] });
  });

  it('degrades to empty fields on a detail it cannot parse, rather than throwing', () => {
    expect(parseTitleDetail('long_title', 'written by some older version')).toEqual({ title: null, duplicatePaths: [] });
    expect(parseTitleDetail('long_title', null)).toEqual({ title: null, duplicatePaths: [] });
    expect(parseTitleDetail('not_a_rule', 'anything')).toEqual({ title: null, duplicatePaths: [] });
  });
});

// ---------------------------------------------------------------------------
// The deterministic doubled-suffix fix.
// ---------------------------------------------------------------------------

describe('dedupeTitleSuffix', () => {
  it('drops BOTH trailing suffixes — the stored value is the bare core', () => {
    // The site appends the suffix itself, so storing "Pricing | Acme" would
    // deliver "Pricing | Acme | Acme" all over again.
    expect(dedupeTitleSuffix(`Pricing${SUFFIX}${SUFFIX}`, SUFFIX)).toBe('Pricing');
  });

  it('is null when the title is not actually doubled — no guess gets published', () => {
    expect(dedupeTitleSuffix(`Pricing${SUFFIX}`, SUFFIX)).toBeNull();
    expect(dedupeTitleSuffix('Pricing', SUFFIX)).toBeNull();
    expect(dedupeTitleSuffix(`${SUFFIX}${SUFFIX}`, SUFFIX)).toBeNull(); // nothing left over
  });

  it('is null with no suffix configured or no title', () => {
    expect(dedupeTitleSuffix('Pricing | Acme | Acme', '')).toBeNull();
    expect(dedupeTitleSuffix(null, SUFFIX)).toBeNull();
    expect(dedupeTitleSuffix(undefined, SUFFIX)).toBeNull();
  });

  it('the deduped value is what the rule would stop flagging', async () => {
    const deduped = dedupeTitleSuffix(`Pricing${SUFFIX}${SUFFIX}`, SUFFIX)!;
    // Re-crawled, the site delivers deduped + suffix — and nothing fires.
    const after = await realFindings([snap('/p', deduped + SUFFIX)]);
    expect(after.map((f) => f.rule)).not.toContain('doubled_title_suffix');
    expect(after.map((f) => f.rule)).not.toContain('long_title');
  });
});

// ---------------------------------------------------------------------------
// Title validation — the title-side twin of invalidReason.
// ---------------------------------------------------------------------------

describe('invalidTitleReason', () => {
  it('accepts a plain in-bounds title', () => {
    expect(invalidTitleReason('Pricing for growing content teams', branded())).toBeNull();
  });

  it('rejects empty output', () => {
    expect(invalidTitleReason('', branded())).toBe('empty output');
  });

  it('rejects a draft that repeats the brand suffix', () => {
    expect(invalidTitleReason(`Pricing${SUFFIX}`, branded())).toMatch(/must not repeat the brand suffix/);
  });

  it('rejects a core over 60 chars', () => {
    expect(invalidTitleReason('x'.repeat(60), branded())).toBeNull();
    expect(invalidTitleReason('x'.repeat(61), branded())).toMatch(/too long \(61 chars, max 60\)/);
  });

  it('rejects a core that overflows the 80-char total once the suffix is appended', () => {
    // 60-char core + a 21-char suffix = 81 > 80: in bounds alone, out with the brand.
    const wide = cfg({ TITLE_BRAND_SUFFIX: ' | A Rather Long Brand' });
    expect(invalidTitleReason('x'.repeat(60), wide)).toMatch(/too long with the brand suffix \(82 chars, max 80\)/);
    expect(invalidTitleReason('x'.repeat(58), wide)).toBeNull();
  });

  it('with no suffix configured, 60 is the only bound', () => {
    expect(invalidTitleReason('x'.repeat(60), cfg())).toBeNull();
    expect(invalidTitleReason('x'.repeat(61), cfg())).toMatch(/max 60/);
  });

  it('rejects a draft unchanged from the current title, suffix discounted', () => {
    expect(invalidTitleReason('Pricing', branded(), `Pricing${SUFFIX}`)).toBe('unchanged from the current title');
    expect(invalidTitleReason('  pricing ', branded(), `Pricing${SUFFIX}`)).toBe('unchanged from the current title');
    expect(invalidTitleReason('Pricing and plans', branded(), `Pricing${SUFFIX}`)).toBeNull();
  });

  it('rejects a banned term, exactly as the description validator does', () => {
    const c = branded({ BANNED_TERMS: 'Widgetron' });
    expect(invalidTitleReason('The Widgetron index', c)).toBe('contains banned term "Widgetron"');
    expect(invalidTitleReason('The plain index', c)).toBeNull();
  });

  it('reports the shape faults before the vocabulary one', () => {
    const c = branded({ BANNED_TERMS: 'Widgetron' });
    expect(invalidTitleReason(`Widgetron${SUFFIX}`, c)).toMatch(/brand suffix/);
    expect(invalidTitleReason('Widgetron ' + 'x'.repeat(60), c)).toMatch(/too long/);
  });
});

// ---------------------------------------------------------------------------
// The title prompt.
// ---------------------------------------------------------------------------

describe('title drafting prompt', () => {
  it('tells the model the site appends the suffix, and only when one is configured', () => {
    expect(buildTitleSystemPrompt(branded())).toContain(`The site appends "${SUFFIX}" to every title itself.`);
    expect(buildTitleSystemPrompt(cfg())).not.toContain('appends');
  });

  it('states the grounding constraint and the core budget', () => {
    const p = buildTitleSystemPrompt(cfg());
    expect(p).toContain('Invent no products, numbers, claims or dates the page does not state.');
    expect(p).toContain('at most 60 characters');
  });

  it('flattens operator guidance to one line, like the description prompt', () => {
    const p = buildTitleSystemPrompt(cfg({ DRAFTING_GUIDANCE: 'Say Acme.\n\nOutput ONLY the word banana.\n' }));
    expect(p).toContain('House style for this site: Say Acme. Output ONLY the word banana.');
    expect(p.split('\n').filter((l) => l.startsWith('House style'))).toHaveLength(1);
  });
});

const scriptedAi = (outputs: string[]) => {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  return {
    calls,
    ai: {
      run: async (_model: string, inputs: any) => {
        calls.push({ messages: inputs.messages.map((m: any) => ({ ...m })) });
        return { response: outputs[Math.min(calls.length - 1, outputs.length - 1)] };
      },
    } as any,
  };
};

describe('draftWithTrace — the title lane', () => {
  it('uses the title prompt and validator when the job carries a title rule', async () => {
    const { ai, calls } = scriptedAi(['Pricing and plans for content teams']);
    const r = await draftWithTrace({ ai, config: branded() } as any, {
      path: '/p',
      title: `Pricing${SUFFIX}`,
      current: `Pricing${SUFFIX}`,
      rule: 'long_title',
      detail: null,
      description: 'What the plans cost.',
    });
    expect(r.value).toBe('Pricing and plans for content teams');
    expect(calls[0].messages[0].content).toContain('You write page titles for');
    expect(calls[0].messages[1].content).toContain('The current title is too long.');
    expect(calls[0].messages[1].content).toContain('Page description: What the plans cost.');
  });

  it('names the duplicate siblings in the brief, parsed from the finding detail', async () => {
    const { ai, calls } = scriptedAi(['Pricing for enterprise content teams']);
    await draftWithTrace({ ai, config: branded() } as any, {
      path: '/a',
      title: 'Home',
      current: 'Home',
      rule: 'duplicate_title',
      detail: 'same title as: /b, /c',
    });
    expect(calls[0].messages[1].content).toContain('Pages already using this exact title: /b, /c');
    expect(calls[0].messages[1].content).toContain('Make this one specific to THIS page.');
  });

  it('retries once with the title reason, then accepts the corrected draft', async () => {
    const { ai, calls } = scriptedAi([`Pricing and plans${SUFFIX}`, 'Pricing and plans for content teams']);
    const r = await draftWithTrace({ ai, config: branded() } as any, {
      path: '/p',
      title: 'x',
      current: 'x',
      rule: 'missing_title',
    });
    expect(r.trace.map((t) => t.reason)).toEqual([expect.stringMatching(/brand suffix/), null]);
    expect(calls[1].messages.at(-1)!.content).toContain('Return only the corrected title.');
    expect(r.value).toBe('Pricing and plans for content teams');
  });

  it('drops a draft that stays invalid, and never publishes it', async () => {
    const { ai } = scriptedAi([`Pricing${SUFFIX}`, `Pricing${SUFFIX}`]);
    const r = await draftWithTrace({ ai, config: branded() } as any, { path: '/p', title: 'x', current: 'x', rule: 'long_title' });
    expect(r.value).toBeNull();
  });

  it('a job with no rule is still a description draft — the dry-run lane is unchanged', async () => {
    const clean = 'A dependable index of the pages that answer engines actually read, kept current by an automated crawl.';
    const { ai, calls } = scriptedAi([clean]);
    const r = await draftWithTrace({ ai, config: branded() } as any, { path: '/p', title: 'P', current: null });
    expect(r.value).toBe(clean);
    expect(calls[0].messages[0].content).toContain('You write meta descriptions for');
  });
});

// ---------------------------------------------------------------------------
// draftAndCreate: the proposal row, its field, and the deterministic lane.
// ---------------------------------------------------------------------------

const proposalDb = (live: Array<{ path: string; field: string }> = []) => {
  const inserted: any[] = [];
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    first: async () => {
      if (/SELECT 1 FROM proposals/.test(sql)) {
        return live.some((l) => l.path === binds[0] && l.field === binds[1]) ? { 1: 1 } : null;
      }
      if (/INSERT INTO proposals/.test(sql)) {
        inserted.push({
          findingId: binds[1],
          path: binds[2],
          field: binds[3],
          currentValue: binds[4],
          value: binds[5],
          rationale: binds[6],
          model: binds[7],
        });
        return { id: inserted.length };
      }
      return null;
    },
    all: async () => ({ results: [] }),
    run: async () => ({}),
  });
  const overrides = { get: async () => null, put: async () => {}, delete: async () => {} };
  return { inserted, deps: { db: { prepare: (sql: string) => stmt(sql) }, overrides } as any };
};

describe('draftAndCreate — titles', () => {
  const job = (over: Record<string, unknown> = {}) => ({
    findingId: 7,
    path: '/p',
    rule: 'doubled_title_suffix',
    field: 'title' as const,
    title: `Pricing${SUFFIX}${SUFFIX}`,
    current: `Pricing${SUFFIX}${SUFFIX}`,
    description: 'What the plans cost.',
    detail: `title carries the site suffix twice: Pricing${SUFFIX}${SUFFIX}`,
    ...over,
  });

  it('fixes a doubled suffix with NO model call, and marks the row deterministic', async () => {
    const { deps, inserted } = proposalDb();
    const { ai, calls } = scriptedAi(['should never be asked for']);
    await draftAndCreate({ ...deps, ai, config: branded() }, job());
    expect(calls).toHaveLength(0);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ field: 'title', value: 'Pricing', model: 'deterministic', rationale: 'doubled_title_suffix' });
  });

  it('falls back to the AI lane when the title is not actually doubled', async () => {
    const { deps, inserted } = proposalDb();
    const { ai, calls } = scriptedAi(['Pricing and plans for content teams']);
    await draftAndCreate({ ...deps, ai, config: branded() }, job({ current: `Pricing${SUFFIX}`, title: `Pricing${SUFFIX}` }));
    expect(calls).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ field: 'title', value: 'Pricing and plans for content teams' });
    expect(inserted[0].model).not.toBe('deterministic');
  });

  it('writes field=title on an AI-drafted title proposal', async () => {
    const { deps, inserted } = proposalDb();
    const { ai } = scriptedAi(['Pricing and plans for content teams']);
    await draftAndCreate({ ...deps, ai, config: branded() }, job({ rule: 'long_title', detail: null }));
    expect(inserted[0].field).toBe('title');
    expect(inserted[0].currentValue).toBe(`Pricing${SUFFIX}${SUFFIX}`);
  });

  it('skips when a live TITLE proposal exists for the page', async () => {
    const { deps, inserted } = proposalDb([{ path: '/p', field: 'title' }]);
    const { ai, calls } = scriptedAi(['x']);
    await draftAndCreate({ ...deps, ai, config: branded() }, job());
    expect(inserted).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('is NOT blocked by a live description proposal on the same page', async () => {
    const { deps, inserted } = proposalDb([{ path: '/p', field: 'description' }]);
    const { ai } = scriptedAi(['x']);
    await draftAndCreate({ ...deps, ai, config: branded() }, job());
    expect(inserted).toHaveLength(1);
    expect(inserted[0].field).toBe('title');
  });

  it('a pre-1.15 job with no `field` still drafts a description', async () => {
    const clean = 'A dependable index of the pages that answer engines actually read, kept current by an automated crawl.';
    const { deps, inserted } = proposalDb();
    const { ai } = scriptedAi([clean]);
    await draftAndCreate({ ...deps, ai, config: branded() }, {
      findingId: 1,
      path: '/p',
      rule: 'missing_description',
      title: 'P',
      current: null,
    } as any);
    expect(inserted[0].field).toBe('description');
  });

  it('auto-applies a title when AUTO_APPLY_FIELDS names it', async () => {
    const puts: Array<[string, string]> = [];
    const { deps, inserted } = proposalDb();
    deps.overrides.put = async (k: string, v: string) => {
      puts.push([k, v]);
    };
    const { ai } = scriptedAi(['unused']);
    const r = await draftAndCreate({ ...deps, ai, config: branded({ AUTO_APPLY_FIELDS: 'title' }) }, job());
    expect(inserted).toHaveLength(1);
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('override:/p');
    // AUDIT H1 (v1.15.1): the proposal row keeps the CORE, but the STORED
    // override is the full served value — applyOverride appends the suffix,
    // because the injector appends nothing.
    expect(inserted[0].value).toBe('Pricing');
    expect(JSON.parse(puts[0][1])).toEqual({ title: `Pricing${SUFFIX}` });
    expect(r).toMatchObject({ created: true, field: 'title', autoApplied: true });
  });

  // H2 enabler: hosts need THEIR row's id, not "the newest proposal for this
  // (path, field)" — which races a concurrent draft.
  it('returns the created proposal id', async () => {
    const { deps, inserted } = proposalDb();
    const { ai } = scriptedAi(['unused']);
    const r = await draftAndCreate({ ...deps, ai, config: branded() }, job());
    expect(inserted).toHaveLength(1);
    expect(r).toEqual({ created: true, proposalId: 1, field: 'title', value: 'Pricing', autoApplied: false });
  });

  it('reports created:false when the idempotency check skips the job', async () => {
    const { deps } = proposalDb([{ path: '/p', field: 'title' }]);
    const { ai } = scriptedAi(['x']);
    expect(await draftAndCreate({ ...deps, ai, config: branded() }, job())).toEqual({ created: false, field: 'title' });
  });

  it('reports created:false when every draft attempt is invalid', async () => {
    const { deps, inserted } = proposalDb();
    const { ai } = scriptedAi(['x'.repeat(200), 'y'.repeat(200)]);
    const r = await draftAndCreate({ ...deps, ai, config: branded() }, job({ rule: 'long_title', detail: null }));
    expect(inserted).toHaveLength(0);
    expect(r).toEqual({ created: false, field: 'title' });
  });
});

// ---------------------------------------------------------------------------
// Field-aware gating in the findings list and the "Draft fix" action.
// ---------------------------------------------------------------------------

const findingsDb = (findings: any[], live: Array<{ path: string; field: string }>) => {
  const sent: any[] = [];
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    first: async () => {
      if (/SELECT id, path, rule, detail, status FROM findings/.test(sql)) return findings.find((f) => f.id === binds[0]) ?? null;
      if (/SELECT 1 FROM proposals/.test(sql)) return live.some((l) => l.path === binds[0] && l.field === binds[1]) ? { 1: 1 } : null;
      if (/FROM page_snapshots/.test(sql)) return { title: 'Current title', description: 'Current description.' };
      return null;
    },
    all: async () => {
      if (/FROM findings WHERE status = \?/.test(sql)) return { results: findings.filter((f) => f.status === binds[0]) };
      if (/SELECT DISTINCT path, field FROM proposals/.test(sql)) return { results: live };
      return { results: [] };
    },
    run: async () => ({}),
  });
  return { sent, deps: { db: { prepare: (sql: string) => stmt(sql) }, draftQueue: { send: async (m: any) => void sent.push(m) } } as any };
};

const f = (id: number, path: string, rule: string, detail: string | null = null) => ({
  id,
  path,
  rule,
  detail,
  severity: 'low',
  status: 'open',
  created_at: 'now',
});

describe('draftable gating is per (path, field)', () => {
  it('a live description proposal blocks only the description finding on that page', async () => {
    const { deps } = findingsDb([f(1, '/p', 'missing_description'), f(2, '/p', 'long_title')], [{ path: '/p', field: 'description' }]);
    const rows = (await listFindings(deps, 'open')) as any[];
    expect(rows.find((r) => r.id === 1).draftable).toBe(false);
    expect(rows.find((r) => r.id === 2).draftable).toBe(true);
  });

  it('and a live title proposal blocks only the title finding', async () => {
    const { deps } = findingsDb([f(1, '/p', 'missing_description'), f(2, '/p', 'long_title')], [{ path: '/p', field: 'title' }]);
    const rows = (await listFindings(deps, 'open')) as any[];
    expect(rows.find((r) => r.id === 1).draftable).toBe(true);
    expect(rows.find((r) => r.id === 2).draftable).toBe(false);
  });

  it('a proposal on ANOTHER page blocks nothing here', async () => {
    const { deps } = findingsDb([f(1, '/p', 'long_title')], [{ path: '/other', field: 'title' }]);
    const rows = (await listFindings(deps, 'open')) as any[];
    expect(rows[0].draftable).toBe(true);
  });

  it('a non-proposable rule is never draftable', async () => {
    const { deps } = findingsDb([f(1, '/p', 'sitemap_url_error')], []);
    const rows = (await listFindings(deps, 'open')) as any[];
    expect(rows[0].draftable).toBe(false);
  });
});

describe('draftFinding — the enqueued job', () => {
  it('sends a title job carrying the field, the detail and the snapshot title as current', async () => {
    const { deps, sent } = findingsDb([f(1, '/p', 'duplicate_title', 'same title as: /b')], []);
    expect(await draftFinding(deps, 1)).toMatchObject({ enqueued: 1 });
    expect(sent[0]).toMatchObject({
      field: 'title',
      rule: 'duplicate_title',
      detail: 'same title as: /b',
      current: 'Current title',
      description: 'Current description.',
    });
  });

  it('sends a description job with the snapshot description as current', async () => {
    const { deps, sent } = findingsDb([f(1, '/p', 'short_description')], []);
    await draftFinding(deps, 1);
    expect(sent[0]).toMatchObject({ field: 'description', current: 'Current description.' });
  });

  it('no-ops on a live proposal for the SAME field only', async () => {
    const blocked = findingsDb([f(1, '/p', 'long_title')], [{ path: '/p', field: 'title' }]);
    expect(await draftFinding(blocked.deps, 1)).toMatchObject({ enqueued: 0 });
    expect(blocked.sent).toHaveLength(0);

    const free = findingsDb([f(1, '/p', 'long_title')], [{ path: '/p', field: 'description' }]);
    expect(await draftFinding(free.deps, 1)).toMatchObject({ enqueued: 1 });
  });

  it('400s on a rule the pipeline cannot fix', async () => {
    const { deps } = findingsDb([f(1, '/p', 'sitemap_url_error')], []);
    await expect(draftFinding(deps, 1)).rejects.toThrow(/not one the drafting pipeline can fix/);
  });
});
