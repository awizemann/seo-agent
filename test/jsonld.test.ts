import { describe, it, expect } from 'vitest';
import {
  OVERRIDE_FIELDS,
  checkJsonLd,
  invalidJsonLdReason,
  storedOverrideValue,
  applyOverride,
  readOverride,
  overrideKey,
  JSONLD_MAX_CHARS,
} from '../src/overrides';
import {
  JSONLD_RULES,
  PROPOSABLE_RULES,
  fieldForRule,
  currentValueFor,
  sanitizeJsonLd,
  buildJsonLdSystemPrompt,
  draftWithTrace,
  draftAndCreate,
  RULE_FIELD_SQL,
} from '../src/propose';
import { createProposal, decideProposal, revertById, listOverrides, ApiError } from '../src/actions';
import { resolveSiteConfig } from '../src/config';

const config = resolveSiteConfig({ SITE_URL: 'https://example.com', SITE_NAME: 'Acme', ARTICLE_PATH_PREFIX: '/articles/' });

/** A minimal valid Article node, as JSON text — the stored-value shape. */
const article = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: 'How caching works', ...extra });

// ---------------------------------------------------------------------------
// checkJsonLd — the one gate. Every lane (apply, manual proposal, AI draft)
// runs this, so the matrix lives here once.
// ---------------------------------------------------------------------------

describe('checkJsonLd — what is publishable', () => {
  it('accepts a minimal Article node and returns it re-serialized', () => {
    const check = checkJsonLd(article());
    expect(check).toMatchObject({ ok: true });
    expect(JSON.parse((check as { value: string }).value)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'How caching works',
    });
  });

  it('accepts an http schema.org context, an array context and an array @type', () => {
    expect(checkJsonLd(JSON.stringify({ '@context': 'http://schema.org', '@type': 'Article' })).ok).toBe(true);
    expect(checkJsonLd(JSON.stringify({ '@context': ['https://schema.org', { x: 'y' }], '@type': 'Article' })).ok).toBe(true);
    expect(checkJsonLd(JSON.stringify({ '@context': 'https://schema.org', '@type': ['Article', 'NewsArticle'] })).ok).toBe(true);
  });

  it('accepts an array of nodes when EVERY node stands on its own', () => {
    const both = JSON.stringify([
      { '@context': 'https://schema.org', '@type': 'Article', headline: 'A' },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList' },
    ]);
    expect(checkJsonLd(both).ok).toBe(true);
  });

  it('rejects an array whose LATER node lacks a context — a node is checked alone', () => {
    const half = JSON.stringify([
      { '@context': 'https://schema.org', '@type': 'Article' },
      { '@type': 'BreadcrumbList' },
    ]);
    expect(invalidJsonLdReason(half)).toMatch(/node 1.*missing "@context"/);
  });

  it('rejects text that is not JSON', () => {
    expect(invalidJsonLdReason('{ not json')).toMatch(/not valid JSON/);
    expect(invalidJsonLdReason('')).toMatch(/not valid JSON/);
  });

  it('rejects JSON that parses to something other than a node', () => {
    for (const scalar of ['"a string"', '42', 'null', 'true']) {
      expect(invalidJsonLdReason(scalar)).toMatch(/must be a JSON object/);
    }
    expect(invalidJsonLdReason('[]')).toMatch(/empty array/);
  });

  it('rejects a missing or non-schema.org @context', () => {
    expect(invalidJsonLdReason(JSON.stringify({ '@type': 'Article' }))).toBe('missing "@context"');
    expect(invalidJsonLdReason(JSON.stringify({ '@context': 'https://example.com/ctx', '@type': 'Article' }))).toMatch(
      /must reference schema\.org/
    );
  });

  it('rejects a missing, empty or non-string @type', () => {
    expect(invalidJsonLdReason(JSON.stringify({ '@context': 'https://schema.org' }))).toBe('missing "@type"');
    expect(invalidJsonLdReason(JSON.stringify({ '@context': 'https://schema.org', '@type': '  ' }))).toMatch(/is empty/);
    expect(invalidJsonLdReason(JSON.stringify({ '@context': 'https://schema.org', '@type': [] }))).toMatch(/empty array/);
    expect(invalidJsonLdReason(JSON.stringify({ '@context': 'https://schema.org', '@type': 7 }))).toMatch(/must be a string/);
  });

  it('rejects a document whose canonical form exceeds the cap, and accepts one at it', () => {
    const pad = (n: number) => article({ articleBody: 'x'.repeat(n) });
    const over = checkJsonLd(pad(JSONLD_MAX_CHARS));
    expect(over).toMatchObject({ ok: false });
    expect((over as { reason: string }).reason).toMatch(/too long/);
    // Shrink until it fits — the bound is on the CANONICAL bytes, not the input.
    let body = JSONLD_MAX_CHARS;
    let ok = checkJsonLd(pad(body));
    while (!ok.ok) ok = checkJsonLd(pad(--body));
    expect((ok as { value: string }).value.length).toBeLessThanOrEqual(JSONLD_MAX_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Script safety. The stored value has to be inert INSIDE a <script> element,
// and it is made inert by escaping rather than by refusing — so the tests
// assert both halves: the bytes carry no `<`, and the meaning is preserved.
// ---------------------------------------------------------------------------

describe('checkJsonLd — </script> smuggling', () => {
  const smuggle = (headline: string) => {
    const check = checkJsonLd(JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline }));
    expect(check.ok).toBe(true);
    return (check as { value: string }).value;
  };

  it('escapes a literal </script> so the stored bytes cannot close the element', () => {
    const value = smuggle('</script><img src=x onerror=alert(1)>');
    expect(value).not.toContain('<');
    expect(value).not.toContain('</');
    expect(value).toContain('\\u003c');
  });

  it('escapes a `<` that arrives as a JSON \\u escape, not just a literal one', () => {
    // The input never contains the character `<` at all — only after parsing
    // does it exist, which is exactly why the check normalizes instead of
    // pattern-matching the raw text.
    const raw = '{"@context":"https://schema.org","@type":"Article","headline":"\\u003c/script\\u003e"}';
    const check = checkJsonLd(raw);
    expect((check as { value: string }).value).not.toContain('<');
  });

  it('escapes an HTML comment opener', () => {
    expect(smuggle('<!--')).not.toContain('<');
  });

  it('preserves the VALUE exactly — the escape is JSON, never an HTML entity', () => {
    const value = smuggle('a < b & c > d');
    expect(value).not.toContain('&lt;');
    expect(value).not.toContain('&amp;');
    expect(JSON.parse(value).headline).toBe('a < b & c > d');
  });

  it('is idempotent: re-checking a stored value yields the same bytes', () => {
    const once = smuggle('</script>');
    expect(checkJsonLd(once)).toEqual({ ok: true, value: once });
  });
});

// ---------------------------------------------------------------------------
// Field enumeration + the apply/revert/journal lifecycle.
// ---------------------------------------------------------------------------

describe('jsonld is a first-class override field', () => {
  it('is in OVERRIDE_FIELDS alongside the copy fields', () => {
    expect([...OVERRIDE_FIELDS].sort()).toEqual(['description', 'jsonld', 'title']);
  });

  it('storedOverrideValue canonicalizes it, and throws rather than storing an invalid one', () => {
    expect(storedOverrideValue('jsonld', article(), undefined)).toBe(checkJsonLd(article()).ok && (checkJsonLd(article()) as any).value);
    expect(() => storedOverrideValue('jsonld', '{ nope', undefined)).toThrow(/invalid jsonld/);
  });

  it('never carries the title brand suffix', () => {
    const stored = storedOverrideValue('jsonld', article(), ' | Acme');
    expect(stored).not.toContain('| Acme');
  });

  it('routes missing_article_jsonld to the jsonld field, in both the function and the SQL', () => {
    expect(fieldForRule('missing_article_jsonld')).toBe('jsonld');
    expect(JSONLD_RULES.has('missing_article_jsonld')).toBe(true);
    expect(PROPOSABLE_RULES.has('missing_article_jsonld')).toBe(true);
    expect(RULE_FIELD_SQL).toContain("'missing_article_jsonld'");
    expect(RULE_FIELD_SQL).toContain("THEN 'jsonld'");
  });

  it('has no current value to show a reviewer — the crawl stores @types, not source', () => {
    expect(currentValueFor('jsonld', { title: 'T', description: 'D' })).toBeNull();
    expect(currentValueFor('title', { title: 'T', description: 'D' })).toBe('T');
    expect(currentValueFor('description', { title: 'T', description: 'D' })).toBe('D');
  });
});

describe('applyOverride / revert — the jsonld lifecycle', () => {
  it('applies, merges beside other fields, journals, and reverts to nothing', async () => {
    const d = deps();
    await applyOverride(d.deps, { path: '/articles/a', field: 'title', value: 'Caching', oldValue: null, source: 'manual' });
    await applyOverride(d.deps, { path: '/articles/a', field: 'jsonld', value: article(), oldValue: null, source: 'manual' });

    const live = await readOverride(d.deps, '/articles/a');
    expect(Object.keys(live).sort()).toEqual(['jsonld', 'title']);
    expect(JSON.parse(live.jsonld)['@type']).toBe('Article');

    const change = d.tables.changes.find((c) => c.field === 'jsonld')!;
    expect(change).toMatchObject({ path: '/articles/a', field: 'jsonld', old_value: null, source: 'manual' });
    // The journal records the SERVED bytes, not the caller's input.
    expect(change.new_value).toBe(live.jsonld);

    await revertById(d.deps, change.id as number);
    const after = await readOverride(d.deps, '/articles/a');
    expect(after.jsonld).toBeUndefined();
    expect(after.title).toBe('Caching'); // the sibling field is untouched
  });

  it('restores the PRIOR document when one was live', async () => {
    const d = deps();
    await applyOverride(d.deps, { path: '/articles/a', field: 'jsonld', value: article(), oldValue: null, source: 'manual' });
    await applyOverride(d.deps, {
      path: '/articles/a',
      field: 'jsonld',
      value: article({ headline: 'Second' }),
      oldValue: null,
      source: 'manual',
    });
    const second = d.tables.changes[1];
    expect(second.old_value).toBe(checkJsonLd(article()).ok && (checkJsonLd(article()) as any).value);

    await revertById(d.deps, second.id as number);
    expect(JSON.parse((await readOverride(d.deps, '/articles/a')).jsonld).headline).toBe('How caching works');
  });

  it('refuses an invalid document at the KV boundary — nothing is written', async () => {
    const d = deps();
    await expect(
      applyOverride(d.deps, { path: '/articles/a', field: 'jsonld', value: '{"@type":"Article"}', oldValue: null, source: 'manual' })
    ).rejects.toThrow(/invalid jsonld/);
    expect(d.store.size).toBe(0);
    expect(d.tables.changes).toHaveLength(0);
  });

  it('still refuses a field that is not overridable at all', async () => {
    await expect(
      applyOverride(deps().deps, { path: '/a', field: 'canonical', value: 'x', oldValue: null, source: 'manual' })
    ).rejects.toThrow(/field not overridable/);
  });
});

// ---------------------------------------------------------------------------
// The wire contract: an override GET hands back the stored JSON verbatim, the
// same way it does for title and description. The edge parses it; nothing in
// between re-encodes it.
// ---------------------------------------------------------------------------

describe('wire contract — listOverrides', () => {
  it('returns the stored JSON text verbatim, wrapper-free', async () => {
    const d = deps();
    await applyOverride(d.deps, { path: '/articles/a', field: 'jsonld', value: article(), oldValue: null, source: 'manual' });

    const [entry] = await listOverrides(d.deps);
    expect(entry.key).toBe(overrideKey('/articles/a'));
    const parsed = JSON.parse(entry.value!) as Record<string, string>;
    // The field value is JSON TEXT inside the override object — one more parse
    // gets the document, and there is no <script> anywhere in the pipe.
    expect(typeof parsed.jsonld).toBe('string');
    expect(parsed.jsonld).not.toContain('script');
    expect(JSON.parse(parsed.jsonld)['@type']).toBe('Article');
    expect(parsed.jsonld).toBe(d.store.get(overrideKey('/articles/a'))!.length ? JSON.parse(d.store.get(overrideKey('/articles/a'))!).jsonld : '');
  });
});

// ---------------------------------------------------------------------------
// Manual proposals through the public action, end to end.
// ---------------------------------------------------------------------------

describe('createProposal — the jsonld field', () => {
  it('accepts a valid document and approving it publishes to KV', async () => {
    const d = deps();
    const created = await createProposal(d.deps, { path: '/articles/a', field: 'jsonld', value: article() }, () => null);
    expect(created).toMatchObject({ ok: true, status: 'proposed' });
    expect(d.tables.proposals[0]).toMatchObject({ field: 'jsonld', path: '/articles/a', current_value: null });

    await decideProposal(d.deps, created.id as number, 'approve');
    const live = await readOverride(d.deps, '/articles/a');
    expect(JSON.parse(live.jsonld)['@type']).toBe('Article');
  });

  it('rejects every invalid document with a 400, before any row is written', async () => {
    for (const bad of ['{ not json', '"a string"', JSON.stringify({ '@type': 'Article' }), JSON.stringify({ '@context': 'https://schema.org' })]) {
      const d = deps();
      const err = await createProposal(d.deps, { path: '/articles/a', field: 'jsonld', value: bad }, () => null).catch((e) => e as ApiError);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toMatch(/invalid jsonld/);
      expect(d.tables.proposals).toHaveLength(0);
    }
  });

  it('stores the CANONICAL form, so a smuggled </script> is inert by the time it is reviewable', async () => {
    const d = deps();
    const created = await createProposal(
      d.deps,
      { path: '/articles/a', field: 'jsonld', value: article({ headline: '</script><script>alert(1)</script>' }) },
      () => null
    );
    await decideProposal(d.deps, created.id as number, 'approve');
    expect((await readOverride(d.deps, '/articles/a')).jsonld).not.toContain('<');
  });
});

// ---------------------------------------------------------------------------
// Drafting: the prompt's grounding, and the withdrawal of a draft that fails
// the SAME validation apply would run.
// ---------------------------------------------------------------------------

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

describe('the jsonld drafting prompt', () => {
  it('forbids invention and instructs the model to omit what the page does not show', () => {
    const prompt = buildJsonLdSystemPrompt(config);
    expect(prompt).toMatch(/OMIT any field you cannot read off the page/);
    expect(prompt).toMatch(/Never invent an author, a publisher, an organization, a date/);
    expect(prompt).toMatch(/No markdown, no code fences, no commentary, no <script> tag/);
  });

  it('grounds the brief in the crawled page and singles out datePublished', async () => {
    const { ai, calls } = scriptedAi([article()]);
    await draftWithTrace({ ai, config } as any, {
      path: '/articles/a',
      title: 'How caching works',
      current: null,
      description: 'A short guide.',
      rule: 'missing_article_jsonld',
    });
    const user = calls[0].messages[1].content;
    expect(user).toContain('/articles/a');
    expect(user).toContain('How caching works');
    expect(user).toContain('A short guide.');
    expect(user).toMatch(/Include "datePublished" ONLY if a publication date appears/);
    expect(user).toMatch(/Omit "author", "publisher" and "image"/);
  });

  it('strips a ```json fence without touching the JSON inside', () => {
    expect(sanitizeJsonLd('```json\n{"a": "b  c"}\n```')).toBe('{"a": "b  c"}');
    expect(sanitizeJsonLd('<think>hmm</think>\n{"a":1}')).toBe('{"a":1}');
    // The prose sanitizer would have collapsed the double space above; this one
    // must not, because that is a value, not formatting.
    expect(sanitizeJsonLd('{"a": "b  c"}')).toContain('b  c');
  });

  it('accepts a fenced draft end to end', async () => {
    const { ai } = scriptedAi(['```json\n' + article() + '\n```']);
    const { value } = await draftWithTrace({ ai, config } as any, {
      path: '/articles/a',
      title: 'T',
      current: null,
      rule: 'missing_article_jsonld',
    });
    expect(JSON.parse(value!)['@type']).toBe('Article');
  });
});

describe('a jsonld draft that fails validation is withdrawn, not stored', () => {
  const job = (over: Record<string, unknown> = {}) => ({
    findingId: 3,
    path: '/articles/a',
    rule: 'missing_article_jsonld',
    field: 'jsonld' as const,
    title: 'How caching works',
    description: 'A short guide.',
    current: null,
    ...over,
  });

  it('retries once and then drops the job — no proposal row, nothing in KV', async () => {
    const d = deps();
    const { ai, calls } = scriptedAi(['not json at all', '{"@type":"Article"}']);
    const result = await draftAndCreate({ ...d.deps, ai, config } as any, job());
    expect(result).toEqual({ created: false, field: 'jsonld' });
    expect(calls).toHaveLength(2); // one draft, one correction turn
    expect(d.tables.proposals).toHaveLength(0);
    expect(d.store.size).toBe(0);
  });

  it('tells the model WHICH way it was invalid on the retry turn', async () => {
    const d = deps();
    const { ai, calls } = scriptedAi([JSON.stringify({ '@context': 'https://schema.org' }), article()]);
    await draftAndCreate({ ...d.deps, ai, config } as any, job());
    const retry = calls[1].messages.at(-1)!.content;
    expect(retry).toMatch(/missing "@type"/);
    expect(retry).toMatch(/Return only the corrected JSON-LD object/);
  });

  it('recovers on the retry and writes the canonical value', async () => {
    const d = deps();
    const { ai } = scriptedAi(['nonsense', article({ headline: '</script>' })]);
    const result = await draftAndCreate({ ...d.deps, ai, config } as any, job());
    expect(result).toMatchObject({ created: true, field: 'jsonld' });
    expect(d.tables.proposals[0].field).toBe('jsonld');
    expect(JSON.parse(d.tables.proposals[0].proposed_value as string).headline).toBe('</script>');
  });

  it('auto-apply publishes the ESCAPED form even though the proposal holds the raw draft', async () => {
    const d = deps();
    const { ai } = scriptedAi([article({ headline: '</script>' })]);
    const autoCfg = { ...config, autoApplyFields: ['jsonld'] };
    await draftAndCreate({ ...d.deps, ai, config: autoCfg } as any, job());
    expect((await readOverride(d.deps, '/articles/a')).jsonld).not.toContain('<');
  });
});

// ---------------------------------------------------------------------------
// Fakes: just enough D1 and KV for the proposal → approve → revert path,
// routed on statement text (an unrecognized query throws, so a changed query
// fails loudly rather than silently returning nothing).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Tables = { proposals: Row[]; changes: Row[]; snapshots: Row[] };

function fakeDb(t: Tables) {
  const run = (sql: string, b: unknown[]) => {
    if (/INSERT INTO proposals/.test(sql)) {
      // The manual lane binds 7 values, the drafting lane 8 (finding_id + model).
      const drafted = b.length === 8;
      const [created_at, path, field, current_value, proposed_value, rationale, model] = drafted
        ? [b[0], b[2], b[3], b[4], b[5], b[6], b[7]]
        : [b[0], b[1], b[2], b[3], b[4], b[5], 'manual'];
      const row = { id: t.proposals.length + 1, created_at, path, field, current_value, proposed_value, rationale, model, status: 'proposed' };
      t.proposals.push(row);
      return { first: row, all: [], meta: {} };
    }
    if (/SELECT 1 FROM proposals/.test(sql)) {
      return { first: t.proposals.find((p) => p.path === b[0] && p.field === b[1] && p.status === 'proposed') ?? null, all: [], meta: {} };
    }
    if (/SELECT \* FROM proposals WHERE id = \? AND status = 'proposed'/.test(sql)) {
      return { first: t.proposals.find((p) => p.id === b[0] && p.status === 'proposed') ?? null, all: [], meta: {} };
    }
    if (/UPDATE proposals SET status = 'reverted'/.test(sql)) {
      const c = t.changes.find((x) => x.id === b[0]);
      const p = t.proposals.find((x) => x.id === c?.proposal_id && x.status === 'approved');
      if (p) p.status = 'reverted';
      return { first: null, all: [], meta: {} };
    }
    if (/UPDATE proposals SET status = '(approved|rejected)'/.test(sql)) {
      const p = t.proposals.find((x) => x.id === b[b.length - 1]);
      if (p) p.status = /'approved'/.test(sql) ? 'approved' : 'rejected';
      return { first: null, all: [], meta: {} };
    }
    if (/INSERT INTO changes/.test(sql)) {
      const [applied_at, path, field, old_value, new_value, source, proposal_id] = b;
      const row = { id: t.changes.length + 1, applied_at, path, field, old_value, new_value, source, proposal_id, reverted_at: null };
      t.changes.push(row);
      return { first: row, all: [], meta: {} };
    }
    if (/SELECT MAX\(id\) AS id FROM changes/.test(sql)) {
      const ids = t.changes.filter((c) => c.path === b[0] && c.field === b[1] && c.reverted_at === null).map((c) => c.id as number);
      return { first: { id: ids.length ? Math.max(...ids) : null }, all: [], meta: {} };
    }
    if (/FROM changes WHERE id = \?/.test(sql)) {
      return { first: t.changes.find((c) => c.id === b[0]) ?? null, all: [], meta: {} };
    }
    if (/UPDATE changes SET reverted_at/.test(sql)) {
      const c = t.changes.find((x) => x.id === b[1]);
      if (c) c.reverted_at = b[0];
      return { first: null, all: [], meta: {} };
    }
    if (/SELECT title, description FROM page_snapshots WHERE path = \?/.test(sql)) {
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

function deps(t: Partial<Tables> = {}) {
  const tables: Tables = { proposals: [], changes: [], snapshots: [], ...t };
  const store = new Map<string, string>();
  const overrides = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })), list_complete: true }),
  } as any;
  return { tables, store, deps: { db: fakeDb(tables), overrides, config } as any };
}
