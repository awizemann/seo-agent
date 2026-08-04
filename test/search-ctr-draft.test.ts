/**
 * `search_impressions_no_clicks` — the CTR finding, and its route to a draft.
 *
 * The finding itself is raised HOST-SIDE (it is computed from Search Console
 * data the library cannot see), so nothing in this repo produces it. What this
 * repo owns is the promise the finding's copy makes: that the description can
 * be rewritten. These tests pin that promise end to end — the rule routes to a
 * field, the "Draft fix" action accepts it, the brief the model receives is
 * about clicks rather than about length, and a draft that hands the current
 * description back is refused.
 */
import { describe, it, expect } from 'vitest';
import {
  DESCRIPTION_RULES,
  TITLE_RULES,
  PROPOSABLE_RULES,
  REWRITE_DESCRIPTION_RULES,
  sameDescription,
  fieldForRule,
  draftWithTrace,
  RULE_FIELD_SQL,
} from '../src/propose';
import { listFindings, draftFinding } from '../src/actions';
import { resolveSiteConfig } from '../src/config';

const RULE = 'search_impressions_no_clicks';
const cfg = (vars: Record<string, string> = {}) =>
  resolveSiteConfig({ SITE_URL: 'https://example.com', SITE_NAME: 'Acme', ...vars });

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

// Both clear the 70–160 window and end in a period, so only the checks under
// test can ever be the reason a draft is refused.
const CURRENT = 'A dependable index of the pages that answer engines actually read, kept current by an automated crawl.';
const REWRITE = 'See which pages answer engines cite, which they skip, and what to change first — updated after every crawl.';

// ---------------------------------------------------------------------------
// Routing. The rule has to resolve to a field or every gate below it is closed.
// ---------------------------------------------------------------------------

describe('search_impressions_no_clicks routes to the description field', () => {
  it('is proposable at all — this is the whole bug', () => {
    expect(fieldForRule(RULE)).toBe('description');
    expect(PROPOSABLE_RULES.has(RULE)).toBe(true);
  });

  it('is a description rule, not a title rule — a page-one ranking is not ours to gamble', () => {
    expect(DESCRIPTION_RULES.has(RULE)).toBe(true);
    expect(TITLE_RULES.has(RULE)).toBe(false);
    // The candidate query's CASE lists the TITLE rules; anything else is a
    // description, so the rule must be absent from it.
    expect(RULE_FIELD_SQL).not.toContain(`'${RULE}'`);
  });

  it('the rewrite set is a subset of the description rules', () => {
    for (const r of REWRITE_DESCRIPTION_RULES) expect(DESCRIPTION_RULES.has(r)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The brief. A low-CTR page's description is present and valid — the default
// "write the meta description" would produce a draft aimed at nothing.
// ---------------------------------------------------------------------------

describe('the drafting prompt for a low-CTR page', () => {
  const userMessage = async (rule?: string) => {
    const { ai, calls } = scriptedAi([REWRITE]);
    await draftWithTrace({ ai, config: cfg() } as any, { path: '/p', title: 'P', current: CURRENT, rule });
    return calls[0].messages.at(-1)!.content;
  };

  it('briefs the model on the click, and forbids restating what is there', async () => {
    const msg = await userMessage(RULE);
    expect(msg).toMatch(/choosing something else/);
    expect(msg).toMatch(/do not restate the current description/);
    // It still gets the grounding every description draft gets.
    expect(msg).toContain('Page path: /p');
    expect(msg).toContain(`Current description: ${CURRENT}`);
  });

  it('leaves the length/presence rules on the original brief', async () => {
    for (const rule of ['missing_description', 'short_description', 'long_description', 'truncated_description', undefined]) {
      const msg = await userMessage(rule);
      expect(msg.endsWith('Write the meta description.')).toBe(true);
      expect(msg).not.toMatch(/choosing something else/);
    }
  });

  it('drafts through the description system prompt, not the title one', async () => {
    const { ai, calls } = scriptedAi([REWRITE]);
    await draftWithTrace({ ai, config: cfg() } as any, { path: '/p', title: 'P', current: CURRENT, rule: RULE });
    expect(calls[0].messages[0].content).toContain('You write meta descriptions for Acme');
  });
});

// ---------------------------------------------------------------------------
// "Different" is enforced, not requested.
// ---------------------------------------------------------------------------

describe('a redraft identical to the current description is refused', () => {
  it('retries once with the reason, and accepts the changed second attempt', async () => {
    const { ai, calls } = scriptedAi([CURRENT, REWRITE]);
    const r = await draftWithTrace({ ai, config: cfg() } as any, { path: '/p', title: 'P', current: CURRENT, rule: RULE });
    expect(r.value).toBe(REWRITE);
    expect(r.trace.map((t) => t.reason)).toEqual(['unchanged from the current description', null]);
    expect(calls[1].messages.at(-1)!.content).toContain('That was invalid: unchanged from the current description');
    expect(calls[1].messages.at(-1)!.content).toContain('corrected meta description');
  });

  it('drops the draft when the retry is unchanged too', async () => {
    const { ai } = scriptedAi([CURRENT, CURRENT]);
    const r = await draftWithTrace({ ai, config: cfg() } as any, { path: '/p', title: 'P', current: CURRENT, rule: RULE });
    expect(r.value).toBeNull();
  });

  it('does not apply to the length rules — their drafts are free to be anything valid', async () => {
    const { ai } = scriptedAi([CURRENT]);
    const r = await draftWithTrace(
      { ai, config: cfg() } as any,
      { path: '/p', title: 'P', current: CURRENT, rule: 'short_description' }
    );
    expect(r.value).toBe(CURRENT);
  });

  it('sameDescription ignores case and whitespace noise, not wording', () => {
    expect(sameDescription(CURRENT, CURRENT)).toBe(true);
    expect(sameDescription(`  ${CURRENT.toUpperCase()}  `, CURRENT)).toBe(true);
    expect(sameDescription(CURRENT.replace(/ /g, '  '), CURRENT)).toBe(true);
    expect(sameDescription(REWRITE, CURRENT)).toBe(false);
    expect(sameDescription(CURRENT, null)).toBe(false);
    expect(sameDescription(CURRENT, '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The button and the route it posts to, on the same fixture the sibling suite
// uses — the flag and the action must agree or one of them is a lie.
// ---------------------------------------------------------------------------

const findingsDb = (findings: any[], live: Array<{ path: string; field: string }>) => {
  const sent: any[] = [];
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    first: async () => {
      if (/SELECT id, path, rule, detail, status FROM findings/.test(sql)) return findings.find((f) => f.id === binds[0]) ?? null;
      if (/SELECT 1 FROM proposals/.test(sql)) return live.some((l) => l.path === binds[0] && l.field === binds[1]) ? { 1: 1 } : null;
      if (/FROM page_snapshots/.test(sql)) return { title: 'Current title', description: CURRENT };
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

const finding = (id: number, path: string, rule: string) => ({
  id, path, rule, detail: 'Google showed this page 4,120 times…', severity: 'medium', status: 'open', created_at: 'now',
});

describe('the Draft fix button and the draft action agree', () => {
  it('the finding is draftable', async () => {
    const { deps } = findingsDb([finding(1, '/p', RULE)], []);
    const rows = (await listFindings(deps, 'open')) as any[];
    expect(rows[0].draftable).toBe(true);
  });

  it('and the action enqueues a description job carrying the page\'s current description', async () => {
    const { deps, sent } = findingsDb([finding(1, '/p', RULE)], []);
    expect(await draftFinding(deps, 1)).toMatchObject({ enqueued: 1 });
    expect(sent[0]).toMatchObject({ field: 'description', rule: RULE, current: CURRENT, path: '/p' });
  });

  it('a live DESCRIPTION proposal closes both at once — no button, no enqueue', async () => {
    const { deps, sent } = findingsDb([finding(1, '/p', RULE)], [{ path: '/p', field: 'description' }]);
    expect((await listFindings(deps, 'open') as any[])[0].draftable).toBe(false);
    expect(await draftFinding(deps, 1)).toMatchObject({ enqueued: 0 });
    expect(sent).toHaveLength(0);
  });

  it('a live TITLE proposal on the same page blocks neither', async () => {
    const { deps } = findingsDb([finding(1, '/p', RULE)], [{ path: '/p', field: 'title' }]);
    expect((await listFindings(deps, 'open') as any[])[0].draftable).toBe(true);
    expect(await draftFinding(deps, 1)).toMatchObject({ enqueued: 1 });
  });
});
