import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../injector/src/index';

// The telemetry tap's CLASSIFIER, driven through the real Worker — no regex is
// re-implemented here, so an ordering mistake in the source shows up as a
// failing kind, not a passing copy of the bug.

function fakeCtx(): ExecutionContext {
  return { waitUntil: vi.fn((p: Promise<unknown>) => void p), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

/** Minimal D1 tap: records the bind values of every aeo_hits insert. */
function fakeTelemetry() {
  const rows: unknown[][] = [];
  return {
    rows,
    db: { prepare: () => ({ bind: (...v: unknown[]) => ({ run: async () => void rows.push(v) }) }) },
  };
}

const baseEnv = { ORIGIN_HOST: 'origin.example.com' };

function htmlOrigin() {
  return vi.fn(async () => new Response('<html><head><title>t</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
}

/** Drive one plain HTML page view carrying `referer` and return the recorded
 *  row, or null when nothing was recorded. Columns follow the INSERT:
 *  [ts, kind, bot, referrer, path, status, served, ua]. */
async function hit(referer?: string, extraHeaders: Record<string, string> = {}) {
  vi.stubGlobal('fetch', htmlOrigin());
  const tel = fakeTelemetry();
  const env = { ...baseEnv, TELEMETRY: tel.db } as unknown as Env;
  const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0', ...extraHeaders };
  if (referer) headers.referer = referer;
  await worker.fetch(new Request('https://example.com/page', { headers }), env, fakeCtx());
  return tel.rows[0] ?? null;
}

const kindOf = (row: unknown[] | null) => (row ? (row[1] as string) : null);
const hostOf = (row: unknown[] | null) => (row ? (row[3] as string | null) : null);

// Every host in the injector's AI_REFERRER_RE. If one of these ever classifies
// as 'search', AI traffic is being relabelled as organic — the failure this
// whole table exists to catch.
const AI_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'www.perplexity.ai',
  'claude.ai',
  'gemini.google.com',
  'bard.google.com',
  'copilot.microsoft.com',
  'copilot.com',
  'grok.com',
  'www.meta.ai',
  'chat.deepseek.com',
  'you.com',
  'poe.com',
  'duck.ai',
];

const SEARCH_HOSTS = [
  'www.google.com',
  'google.com',
  'www.google.co.uk',
  'google.de',
  'www.google.com.br',
  'www.bing.com',
  'duckduckgo.com',
  'html.duckduckgo.com',
  'search.yahoo.com',
  'uk.search.yahoo.com',
  'search.yahoo.co.jp',
  'search.brave.com',
  'www.ecosia.org',
  'www.startpage.com',
  'www.qwant.com',
  'lite.qwant.com',
  'kagi.com',
  'www.mojeek.com',
  'yandex.com',
  'yandex.ru',
  'www.yandex.com.tr',
  'www.baidu.com',
  'm.baidu.com',
  'search.naver.com',
  'm.search.naver.com',
  'search.seznam.cz',
];

describe('AEO tap — AI wins over search (ordering)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['https://gemini.google.com/', 'referral'],
    ['https://bard.google.com/', 'referral'],
    ['https://www.google.com/', 'search'],
  ])('%s → %s', async (ref, expected) => {
    expect(kindOf(await hit(ref))).toBe(expected);
  });

  it.each(AI_HOSTS)('AI host %s still classifies as referral', async (host) => {
    const row = await hit(`https://${host}/`);
    expect(kindOf(row)).toBe('referral');
    expect(hostOf(row)).toBe(host);
  });

  it('copilot.microsoft.com is referral even though bing.com is a search host', async () => {
    expect(kindOf(await hit('https://copilot.microsoft.com/'))).toBe('referral');
    expect(kindOf(await hit('https://www.bing.com/'))).toBe('search');
  });
});

describe('AEO tap — search referrals', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(SEARCH_HOSTS)('%s classifies as search', async (host) => {
    const row = await hit(`https://${host}/`);
    expect(kindOf(row)).toBe('search');
    expect(hostOf(row)).toBe(host);
  });

  it('records the HOST ONLY — never the path or query', async () => {
    const row = await hit('https://www.google.com/search?q=secret+terms&uid=abc123#frag');
    expect(kindOf(row)).toBe('search');
    expect(hostOf(row)).toBe('www.google.com');
    expect(JSON.stringify(row)).not.toContain('secret');
    expect(JSON.stringify(row)).not.toContain('abc123');
  });
});

describe('AEO tap — what must NOT be recorded', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    'https://someblog.example/post/1',
    'https://news.ycombinator.com/',
    'https://t.co/abc',
    'https://news.google.com/', // a Google subdomain that is not search
    'https://mail.yandex.ru/',
    'https://blog.naver.com/someone',
  ])('non-search cross-origin referrer %s records nothing', async (ref) => {
    expect(await hit(ref)).toBe(null);
  });

  it('a same-site referrer (internal navigation) is never recorded', async () => {
    expect(await hit('https://example.com/other-page')).toBe(null);
  });

  it('a self-referral is not recorded even if the site were hosted on a search-looking host', async () => {
    vi.stubGlobal('fetch', htmlOrigin());
    const tel = fakeTelemetry();
    const env = { ...baseEnv, TELEMETRY: tel.db } as unknown as Env;
    await worker.fetch(
      new Request('https://www.google.com/page', { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.google.com/other' } }),
      env,
      fakeCtx()
    );
    expect(tel.rows).toHaveLength(0);
  });

  it('no referrer at all on a plain HTML view records nothing', async () => {
    expect(await hit()).toBe(null);
  });
});

describe('AEO tap — the original three kinds are unchanged', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a known AI bot UA is a crawler, and the bot wins over any referrer', async () => {
    const row = await hit('https://www.google.com/', { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.1)' });
    expect(kindOf(row)).toBe('crawler');
    expect(row?.[2]).toBe('GPTBot');
  });

  it('an AI referral is still a referral', async () => {
    expect(kindOf(await hit('https://chatgpt.com/'))).toBe('referral');
  });

  it("an unknown client that negotiated markdown is an 'agent'", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('# md', { status: 200, headers: { 'content-type': 'text/markdown' } }))
    );
    const tel = fakeTelemetry();
    const env = { ...baseEnv, TELEMETRY: tel.db } as unknown as Env;
    await worker.fetch(
      new Request('https://example.com/page', { headers: { accept: 'text/markdown', 'user-agent': 'some-agent/1' } }),
      env,
      fakeCtx()
    );
    expect(kindOf(tel.rows[0] ?? null)).toBe('agent');
  });

  it('the agent never self-counts', async () => {
    expect(await hit('https://www.google.com/', { 'user-agent': 'seo-agent/1.16.0' })).toBe(null);
  });

  it('telemetry stays fail-open: a throwing D1 still serves the page', async () => {
    vi.stubGlobal('fetch', htmlOrigin());
    const db = { prepare: () => { throw new Error('d1 down'); } };
    const env = { ...baseEnv, TELEMETRY: db } as unknown as Env;
    const res = await worker.fetch(
      new Request('https://example.com/page', { headers: { referer: 'https://www.google.com/' } }),
      env,
      fakeCtx()
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>t</title>');
  });
});

// ---------------------------------------------------------------------------
// H1 — AI_REFERRER_RE is matched against the anchored HOSTNAME, not the URL.
//
// Every case below PASSED THE BUG: the old regex was tested against the full
// referrer string, unanchored, so any URL containing an AI host's name anywhere
// — including in a search query the user typed — classified as 'referral'.
// Revert the anchor in injector/src/index.ts and every `it` here fails.
// ---------------------------------------------------------------------------
describe('AEO tap — H1: AI referrers match the HOST, never the full URL', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a Google search FOR an AI product is search traffic, not an AI referral', async () => {
    const row = await hit('https://www.google.com/search?q=is+claude.ai+good');
    expect(kindOf(row)).toBe('search');
    expect(hostOf(row)).toBe('www.google.com');
  });

  it.each([
    ['https://www.bing.com/search?q=chatgpt.com+alternatives', 'search', 'www.bing.com'],
    ['https://duckduckgo.com/?q=perplexity.ai+review', 'search', 'duckduckgo.com'],
  ])('%s stays %s', async (ref, kind, host) => {
    const row = await hit(ref);
    expect(kindOf(row)).toBe(kind);
    expect(hostOf(row)).toBe(host);
  });

  it('a blog post ABOUT an AI product is not an AI referral (nothing recorded)', async () => {
    expect(await hit('https://someblog.example/post-about-claude.ai')).toBe(null);
  });

  it('a crafted Referer path cannot mint AI referrals', async () => {
    // Attacker-controlled bytes: the path is the only place the AI host appears.
    expect(await hit('https://attacker.example/chatgpt.com/claude.ai/perplexity.ai')).toBe(null);
  });

  it('a lookalike host that merely ENDS in an AI name is not a match', async () => {
    expect(await hit('https://notclaude.ai/')).toBe(null);
    expect(await hit('https://fakechatgpt.com/')).toBe(null);
  });

  it('the recorded row is never self-contradictory (referral kind on a search host)', async () => {
    for (const ref of [
      'https://www.google.com/search?q=claude.ai',
      'https://www.google.com/',
      'https://gemini.google.com/app/x',
    ]) {
      const row = await hit(ref);
      const kind = kindOf(row);
      const host = hostOf(row) ?? '';
      if (kind === 'referral') expect(host).not.toBe('www.google.com');
      if (kind === 'search') expect(host).not.toBe('gemini.google.com');
    }
  });

  it('genuine AI hosts with a leading label still classify as referral', async () => {
    for (const host of ['www.perplexity.ai', 'chat.deepseek.com', 'www.chatgpt.com']) {
      expect(kindOf(await hit(`https://${host}/thread/abc`))).toBe('referral');
    }
  });
});
