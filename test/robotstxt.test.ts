import { describe, it, expect, vi, afterEach } from 'vitest';
import { appendAiPolicy, generateRobotsProposal, AI_POLICY_BEGIN, AI_POLICY_END } from '../src/robotstxt';
import { ANSWER_ENGINE_BOTS, parseRobots, robotsDecision } from '../src/aeo';
import { ApiError } from '../src/actions';

// ---------------------------------------------------------------------------
// appendAiPolicy — pure, no fakes needed.
// ---------------------------------------------------------------------------

const BOTS = ['OAI-SearchBot', 'PerplexityBot', 'Googlebot'];
const groupsIn = (body: string) => body.split(/\r?\n/).filter((l) => /^User-agent:/i.test(l.trim()));

describe('appendAiPolicy', () => {
  it('appends a fenced group per bot the file never mentions', () => {
    const out = appendAiPolicy('User-agent: *\nAllow: /\n', BOTS);
    expect(out.startsWith('User-agent: *\nAllow: /\n')).toBe(true);
    expect(out).toContain(AI_POLICY_BEGIN);
    expect(out).toContain(AI_POLICY_END);
    for (const bot of BOTS) expect(out).toContain(`User-agent: ${bot}\nAllow: /`);
  });

  it('leaves every existing byte in place (the input is a prefix of the output)', () => {
    const current = '# hand written\nUser-agent: *\nDisallow: /admin/\nCrawl-delay: 5\n\nSitemap: https://x.test/sitemap.xml\n';
    const out = appendAiPolicy(current, BOTS);
    expect(out.startsWith(current)).toBe(true);
  });

  it('skips a bot the file already names, in any case, allowed or disallowed', () => {
    const current = 'User-agent: *\nAllow: /\n\nuser-agent: googlebot\nDisallow: /private/\n\nUser-agent: PERPLEXITYBOT\nAllow: /\n';
    const out = appendAiPolicy(current, BOTS);
    // The Disallow'd bot is never contradicted: no new group is written for it.
    expect(out.slice(current.length)).not.toMatch(/googlebot/i);
    expect(out.slice(current.length)).not.toMatch(/perplexity/i);
    expect(out).toContain('User-agent: OAI-SearchBot');
    expect(out).toContain('Disallow: /private/'); // the owner's line, untouched
  });

  it('never flips a bot the * group blocks from deny to allow', () => {
    const current = 'User-agent: *\nDisallow: /\n';
    expect(appendAiPolicy(current, BOTS)).toBe(current);
  });

  it('carries the * group rules into each added group, so effective policy is unchanged', () => {
    const current = 'User-agent: *\nDisallow: /admin/\nAllow: /admin/public/\n';
    const out = appendAiPolicy(current, ['Googlebot']);
    const before = parseRobots(current);
    const after = parseRobots(out);
    for (const path of ['/', '/admin/x', '/admin/public/x', '/blog/post']) {
      expect(robotsDecision(after, 'Googlebot', path)).toBe(robotsDecision(before, 'Googlebot', path));
    }
    // and the policy is now explicit, which is the whole point
    expect(after.some((g) => g.agents.includes('Googlebot'))).toBe(true);
  });

  it('replaces the managed block on a second run instead of duplicating it', () => {
    const once = appendAiPolicy('User-agent: *\nAllow: /\n', BOTS);
    const twice = appendAiPolicy(once, BOTS);
    expect(twice).toBe(once);
    expect(once.match(new RegExp(AI_POLICY_BEGIN.replace(/[-[\]{}()*+?.\\^$|]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('regenerates in place, picking up bots added to the list since', () => {
    const once = appendAiPolicy('User-agent: *\nAllow: /\n', ['Googlebot']);
    const twice = appendAiPolicy(once, ['Googlebot', 'Bingbot']);
    expect(groupsIn(twice).filter((l) => /Googlebot/.test(l))).toHaveLength(1);
    expect(twice).toContain('User-agent: Bingbot');
    expect(twice.startsWith('User-agent: *\nAllow: /\n')).toBe(true);
  });

  it('collapses a file that somehow contains the managed markers twice', () => {
    const once = appendAiPolicy('User-agent: *\nAllow: /\n', BOTS);
    const doubled = once + '\n' + once.slice(once.indexOf(AI_POLICY_BEGIN));
    const fixed = appendAiPolicy(doubled, BOTS);
    expect(fixed.split(AI_POLICY_BEGIN)).toHaveLength(2); // exactly one marker
    expect(fixed.startsWith('User-agent: *\nAllow: /\n')).toBe(true);
  });

  it('leaves a dangling BEGIN marker alone rather than swallowing the file', () => {
    const current = `User-agent: *\nAllow: /\n${AI_POLICY_BEGIN}\n# truncated\n`;
    const out = appendAiPolicy(current, BOTS);
    expect(out.startsWith(current)).toBe(true);
    expect(out).toContain('# truncated');
  });

  it('keeps a trailing newline when the file has one, and none when it does not', () => {
    expect(appendAiPolicy('User-agent: *\nAllow: /\n', BOTS).endsWith('\n')).toBe(true);
    const noNewline = appendAiPolicy('User-agent: *\nAllow: /', BOTS);
    expect(noNewline.endsWith('\n')).toBe(false);
    expect(noNewline.startsWith('User-agent: *\nAllow: /')).toBe(true);
  });

  it('stays CRLF for a CRLF file', () => {
    const current = 'User-agent: *\r\nAllow: /\r\n';
    const out = appendAiPolicy(current, BOTS);
    expect(out.startsWith(current)).toBe(true);
    expect(out.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
    expect(out).toContain('User-agent: OAI-SearchBot\r\nAllow: /\r\n');
  });

  it('parses past a BOM, so a BOM file does not re-add a bot it already names', () => {
    const current = '﻿User-agent: Googlebot\nDisallow: /x\n';
    const out = appendAiPolicy(current, ['Googlebot', 'Bingbot']);
    expect(out.startsWith('﻿')).toBe(true);
    expect(groupsIn(out).filter((l) => /Googlebot/.test(l))).toHaveLength(1);
    expect(out).toContain('User-agent: Bingbot');
  });

  it('returns the body unchanged when every bot is already covered', () => {
    const current = ANSWER_ENGINE_BOTS.map((b) => `User-agent: ${b}\nAllow: /\n`).join('\n');
    expect(appendAiPolicy(current, ANSWER_ENGINE_BOTS)).toBe(current);
  });

  it('emits just the block for an empty file', () => {
    const out = appendAiPolicy('', ['Googlebot']);
    expect(out).toBe(`${AI_POLICY_BEGIN}\n\nUser-agent: Googlebot\nAllow: /\n${AI_POLICY_END}\n`);
  });
});

// ---------------------------------------------------------------------------
// generateRobotsProposal — fake D1/KV, stubbed fetch.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function fakeDeps() {
  const proposals: Row[] = [];
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    first: async () => {
      if (!/INSERT INTO proposals/.test(sql)) throw new Error(`fakeDb: unhandled statement: ${sql}`);
      const [created_at, path, field, current_value, proposed_value, rationale] = binds;
      const row = { id: proposals.length + 1, created_at, path, field, current_value, proposed_value, rationale };
      proposals.push(row);
      return row;
    },
    all: async () => ({ results: [] }),
    run: async () => ({}),
  });
  return {
    proposals,
    deps: {
      db: { prepare: (sql: string) => stmt(sql) },
      overrides: { get: async () => null, put: async () => {}, delete: async () => {} },
      config: { siteUrl: 'https://example.com' },
    } as any,
  };
}

const stubFetch = (res: Response) => vi.stubGlobal('fetch', vi.fn(async () => res));

describe('generateRobotsProposal', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('appends to a real origin robots.txt and journals it as current_value', async () => {
    const origin = 'User-agent: *\nDisallow: /admin/\n';
    stubFetch(new Response(origin, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const d = fakeDeps();
    expect(await generateRobotsProposal(d.deps)).toMatchObject({ ok: true, id: 1, status: 'proposed' });
    expect(d.proposals[0]).toMatchObject({ path: '/robots.txt', field: 'robots_txt', current_value: origin, rationale: 'ai-policy append' });
    expect(String(d.proposals[0].proposed_value).startsWith(origin)).toBe(true);
    expect(String(d.proposals[0].proposed_value)).toContain('User-agent: OAI-SearchBot');
  });

  it('synthesizes a minimal file on a 404, with no current value', async () => {
    stubFetch(new Response('nope', { status: 404 }));
    const d = fakeDeps();
    await generateRobotsProposal(d.deps);
    const body = String(d.proposals[0].proposed_value);
    expect(d.proposals[0].current_value).toBeNull();
    expect(body.startsWith('User-agent: *\nAllow: /\n')).toBe(true);
    expect(body).toContain(AI_POLICY_BEGIN);
    expect(body.trimEnd().endsWith('Sitemap: https://example.com/sitemap.xml')).toBe(true);
  });

  it('synthesizes on an HTML soft-404 rather than appending to a web page', async () => {
    stubFetch(new Response('<!doctype html><html>not found</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const d = fakeDeps();
    await generateRobotsProposal(d.deps);
    const body = String(d.proposals[0].proposed_value);
    expect(body).not.toContain('<html');
    expect(body.startsWith('User-agent: *\nAllow: /\n')).toBe(true);
  });

  it('appends to (never replaces) a real robots.txt mislabelled as text/html', async () => {
    const origin = 'User-agent: *\nDisallow: /admin/\n';
    stubFetch(new Response(origin, { status: 200, headers: { 'content-type': 'text/html' } }));
    const d = fakeDeps();
    await generateRobotsProposal(d.deps);
    expect(d.proposals[0].current_value).toBe(origin);
    expect(String(d.proposals[0].proposed_value).startsWith(origin)).toBe(true);
  });

  it('synthesizes when the origin is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
    const d = fakeDeps();
    await generateRobotsProposal(d.deps);
    expect(d.proposals[0].current_value).toBeNull();
    expect(String(d.proposals[0].proposed_value)).toContain(AI_POLICY_END);
  });

  it('409s when the origin file already names every AI crawler', async () => {
    stubFetch(
      new Response(ANSWER_ENGINE_BOTS.map((b) => `User-agent: ${b}\nAllow: /\n`).join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    );
    const d = fakeDeps();
    const err = await generateRobotsProposal(d.deps).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(d.proposals).toHaveLength(0);
  });

  it('409s rather than proposing a no-op when the origin blocks everything', async () => {
    stubFetch(new Response('User-agent: *\nDisallow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const err = await generateRobotsProposal(fakeDeps().deps).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
  });
});
