import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseRobotsRules, robotsAllows, normalizeLink, runCrawl, MAX_CRAWL_DEPTH } from '../src/crawl';
import { BYPASS_HEADER, BYPASS_RESOURCE } from '../src/robotstxt';
import { discoveryFindings } from '../src/rules';

const ORIGIN = 'https://example.com';

describe('parseRobotsRules', () => {
  it('takes the * group when no group names us', () => {
    const txt = 'User-agent: *\nDisallow: /admin/\nDisallow: /tmp\nAllow: /admin/public\n';
    expect(parseRobotsRules(txt, 'seo-agent')).toEqual({ allow: ['/admin/public'], disallow: ['/admin/', '/tmp'] });
  });

  it('a group naming us wins over the * group outright', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: seo-agent\nDisallow: /private/\n';
    expect(parseRobotsRules(txt, 'seo-agent')).toEqual({ allow: [], disallow: ['/private/'] });
  });

  it('treats a blank Disallow as allow-all, and ignores comments and junk lines', () => {
    const txt = '# hello\nUser-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\nnot a directive\n';
    expect(parseRobotsRules(txt, 'seo-agent')).toEqual({ allow: [], disallow: [] });
  });

  it('merges consecutive user-agent lines that share one directive block', () => {
    const txt = 'User-agent: seo-agent\nUser-agent: OtherBot\nDisallow: /x\n';
    expect(parseRobotsRules(txt, 'seo-agent').disallow).toEqual(['/x']);
  });
});

describe('robotsAllows', () => {
  const rules = { allow: ['/admin/public'], disallow: ['/admin/', '/*.php', '/end$'] };

  it('blocks a prefix match and allows everything else', () => {
    expect(robotsAllows('/admin/secret', rules)).toBe(false);
    expect(robotsAllows('/blog/post', rules)).toBe(true);
  });

  it('lets the longer Allow beat a shorter Disallow', () => {
    expect(robotsAllows('/admin/public/page', rules)).toBe(true);
  });

  it('honours * and $ in patterns', () => {
    expect(robotsAllows('/a/b/c.php', rules)).toBe(false);
    expect(robotsAllows('/end', rules)).toBe(false);
    expect(robotsAllows('/end/more', rules)).toBe(true);
  });

  it('allows everything when there are no rules at all', () => {
    expect(robotsAllows('/anything', { allow: [], disallow: [] })).toBe(true);
  });
});

describe('normalizeLink', () => {
  const base = 'https://example.com/blog/post';

  it('resolves relative links against the page they were found on', () => {
    expect(normalizeLink('../about', base, ORIGIN)).toBe('https://example.com/about');
    expect(normalizeLink('/a', base, ORIGIN)).toBe('https://example.com/a');
  });

  it('strips the fragment so #anchors are not separate pages', () => {
    expect(normalizeLink('/a#top', base, ORIGIN)).toBe('https://example.com/a');
    expect(normalizeLink('#top', base, ORIGIN)).toBeNull();
  });

  it('rejects other origins, lookalikes and non-http schemes', () => {
    expect(normalizeLink('https://evil.net/a', base, ORIGIN)).toBeNull();
    expect(normalizeLink('https://example.com.evil.net/a', base, ORIGIN)).toBeNull();
    expect(normalizeLink('mailto:a@example.com', base, ORIGIN)).toBeNull();
    expect(normalizeLink('javascript:alert(1)', base, ORIGIN)).toBeNull();
  });

  it('rejects paths that name a non-HTML file, query string or not', () => {
    expect(normalizeLink('/logo.png', base, ORIGIN)).toBeNull();
    expect(normalizeLink('/feed.xml', base, ORIGIN)).toBeNull();
    expect(normalizeLink('/paper.pdf?v=2', base, ORIGIN)).toBeNull();
    expect(normalizeLink('/page.html', base, ORIGIN)).toBe('https://example.com/page.html');
  });
});

describe('discoveryFindings', () => {
  it('says nothing when the sitemap did its job', () => {
    expect(discoveryFindings({ mode: 'sitemap', reason: null, pages: 12 })).toEqual([]);
  });

  it('raises one low-severity sitemap_missing on / that names the reason and the page count', () => {
    const [f] = discoveryFindings({ mode: 'homepage_crawl', reason: 'no sitemap at /sitemap.xml (HTTP 404)', pages: 7 });
    expect(f).toMatchObject({ path: '/', rule: 'sitemap_missing', severity: 'low' });
    expect(f.detail).toContain('HTTP 404');
    expect(f.detail).toContain('7 pages');
  });
});

// --- runCrawl fallback -------------------------------------------------------
// The crawl parses with HTMLRewriter, which only exists on workerd. Stand in a
// minimal one that honours the two selectors the fallback depends on (the page
// title and its anchors) so the BFS bounds are exercised for real.
function stubHtmlRewriter() {
  class FakeRewriter {
    private handlers: [string, any][] = [];
    on(selector: string, handlers: any) {
      this.handlers.push([selector, handlers]);
      return this;
    }
    transform(res: Response) {
      const self = this;
      return {
        async arrayBuffer() {
          const html = await res.text();
          for (const [selector, h] of self.handlers) {
            if (selector === 'head > title' && h.text) {
              const m = html.match(/<title>([^<]*)<\/title>/);
              if (m) h.text({ text: m[1] });
            }
            if (selector === 'a[href]' && h.element) {
              for (const tag of html.match(/<a\b[^>]*>/g) ?? []) {
                h.element({
                  getAttribute: (name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null,
                });
              }
            }
            if (selector === 'meta[name="robots"]' && h.element) {
              for (const tag of html.match(/<meta\b[^>]*name="robots"[^>]*>/g) ?? []) {
                h.element({ getAttribute: (name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null });
              }
            }
          }
          return new ArrayBuffer(0);
        },
      };
    }
  }
  vi.stubGlobal('HTMLRewriter', FakeRewriter);
}

const page = (body: string) => new Response(`<html><head><title>t</title></head><body>${body}</body></html>`, {
  status: 200,
  headers: { 'content-type': 'text/html' },
});

/** Deps whose D1 swallows the snapshot writes and records nothing we assert on. */
function fakeDeps(pageCap = 50) {
  return {
    db: {
      prepare: () => ({ bind: () => ({ run: async () => ({}) }) }),
      batch: async () => [],
    },
    config: { siteUrl: ORIGIN, pageCap },
  } as any;
}

/** Serve a site as a path -> html map, plus optional sitemap/robots responses. */
function serve(site: Record<string, string>, opts: { sitemap?: Response; robots?: string } = {}) {
  const fn = vi.fn(async (input: RequestInfo) => {
    const url = new URL(String(input));
    if (url.pathname === '/sitemap.xml') return opts.sitemap ?? new Response('nope', { status: 404 });
    if (url.pathname === '/robots.txt') {
      return opts.robots === undefined ? new Response('nope', { status: 404 }) : new Response(opts.robots, { status: 200 });
    }
    const body = site[url.pathname];
    if (body === undefined) return new Response('missing', { status: 404, headers: { 'content-type': 'text/html' } });
    return page(body);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const pathsOf = (snapshots: { path: string }[]) => snapshots.map((s) => s.path).sort();

describe('runCrawl homepage-crawl fallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('crawls from / when there is no sitemap, and reports the discovery mode', async () => {
    stubHtmlRewriter();
    serve({
      '/': '<a href="/a">a</a><a href="/b">b</a>',
      '/a': '<a href="/c">c</a>',
      '/b': '',
      '/c': '',
    });
    const { snapshots, discovery } = await runCrawl(fakeDeps(), 1);
    expect(pathsOf(snapshots)).toEqual(['/', '/a', '/b', '/c']);
    expect(discovery).toMatchObject({ mode: 'homepage_crawl', pages: 4 });
    expect(discovery.reason).toContain('HTTP 404');
  });

  it('still prefers the sitemap when there is one, and reports mode=sitemap', async () => {
    stubHtmlRewriter();
    serve(
      { '/': '<a href="/a">a</a>', '/only': '' },
      { sitemap: new Response('<urlset><url><loc>https://example.com/only</loc></url></urlset>', { status: 200 }) }
    );
    const { snapshots, discovery } = await runCrawl(fakeDeps(), 1);
    expect(pathsOf(snapshots)).toEqual(['/only']);
    expect(discovery).toEqual({ mode: 'sitemap', reason: null, pages: 1 });
  });

  // v1.19.1. Since v1.19.0 we can PUBLISH a /sitemap.xml at the edge, which the
  // injector serves before the origin. Discovery must never read that back: it
  // would run the crawl off a page list we wrote, resolve `sitemap_missing`
  // because "a sitemap parses" (ours), and freeze the file it stopped offering
  // to regenerate. The bypass header keeps the question about the SITE.
  it('asks the ORIGIN for the sitemap, bypassing any sitemap WE publish', async () => {
    stubHtmlRewriter();
    const fetchMock = serve(
      { '/': '', '/only': '' },
      { sitemap: new Response('<urlset><url><loc>https://example.com/only</loc></url></urlset>', { status: 200 }) },
    );
    await runCrawl(fakeDeps(), 1);
    const call = fetchMock.mock.calls.find(([i]) => String(i).endsWith('/sitemap.xml'));
    expect(call).toBeDefined();
    expect((call![1] as RequestInit & { headers: Record<string, string> }).headers[BYPASS_HEADER]).toBe(BYPASS_RESOURCE);
  });

  // The page fetches deliberately do NOT bypass: a page must be snapshotted as
  // a crawler receives it, overrides and all — that is what the rules judge.
  it('does NOT bypass on the page fetches themselves', async () => {
    stubHtmlRewriter();
    const fetchMock = serve({ '/': '' });
    await runCrawl(fakeDeps(), 1);
    const pageCall = fetchMock.mock.calls.find(([i]) => String(i) === `${ORIGIN}/`);
    expect(pageCall).toBeDefined();
    expect((pageCall![1] as RequestInit & { headers: Record<string, string> }).headers[BYPASS_HEADER]).toBeUndefined();
  });

  it('falls back when the sitemap is present but parses to zero URLs', async () => {
    stubHtmlRewriter();
    serve({ '/': '' }, { sitemap: new Response('<urlset></urlset>', { status: 200 }) });
    const { discovery } = await runCrawl(fakeDeps(), 1);
    expect(discovery.mode).toBe('homepage_crawl');
    expect(discovery.reason).toContain('no usable URLs');
  });

  it('falls back when the sitemap fetch throws', async () => {
    stubHtmlRewriter();
    const site = { '/': '' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = new URL(String(input));
        if (url.pathname === '/sitemap.xml') throw new Error('connect ECONNREFUSED');
        if (url.pathname === '/robots.txt') return new Response('nope', { status: 404 });
        return page(site[url.pathname as keyof typeof site] ?? '');
      })
    );
    const { discovery } = await runCrawl(fakeDeps(), 1);
    expect(discovery.mode).toBe('homepage_crawl');
    expect(discovery.reason).toContain('ECONNREFUSED');
  });

  it('honours robots.txt Disallow while crawling', async () => {
    stubHtmlRewriter();
    serve(
      { '/': '<a href="/ok">ok</a><a href="/private/x">no</a>', '/ok': '', '/private/x': '' },
      { robots: 'User-agent: *\nDisallow: /private/\n' }
    );
    const { snapshots } = await runCrawl(fakeDeps(), 1);
    expect(pathsOf(snapshots)).toEqual(['/', '/ok']);
  });

  it('skips rel=nofollow links, and every link on a meta-robots nofollow page', async () => {
    stubHtmlRewriter();
    serve({
      '/': '<a href="/keep">k</a><a href="/skip" rel="nofollow">s</a><a href="/dead-end">d</a>',
      '/keep': '',
      '/skip': '',
      '/dead-end': '<meta name="robots" content="nofollow"><a href="/beyond">b</a>',
      '/beyond': '',
    });
    const { snapshots } = await runCrawl(fakeDeps(), 1);
    expect(pathsOf(snapshots)).toEqual(['/', '/dead-end', '/keep']);
  });

  it('stops at MAX_CRAWL_DEPTH levels below the homepage', async () => {
    stubHtmlRewriter();
    const site: Record<string, string> = { '/': '<a href="/d1">1</a>' };
    for (let i = 1; i <= MAX_CRAWL_DEPTH + 2; i++) site[`/d${i}`] = `<a href="/d${i + 1}">n</a>`;
    serve(site);
    const { snapshots } = await runCrawl(fakeDeps(), 1);
    // depth 0 is '/', so MAX_CRAWL_DEPTH more levels are reachable.
    expect(snapshots).toHaveLength(MAX_CRAWL_DEPTH + 1);
    expect(pathsOf(snapshots)).not.toContain(`/d${MAX_CRAWL_DEPTH + 1}`);
  });

  it('never fetches more than the page cap, however many links a trap generates', async () => {
    stubHtmlRewriter();
    // The classic infinite calendar: every month links to the next one.
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt') return new Response('nope', { status: 404 });
      const n = Number(url.searchParams.get('m') ?? 0);
      return page(`<a href="/calendar?m=${n + 1}">next</a><a href="/calendar?m=${n + 2}">skip</a>`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { snapshots } = await runCrawl(fakeDeps(5), 1);
    expect(snapshots.length).toBeLessThanOrEqual(5);
    // Bounded by the cap AND by the depth — the trap cannot outrun either.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5 + 2);
  });

  it('follows a same-origin redirect on / without snapshotting the hop', async () => {
    stubHtmlRewriter();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = new URL(String(input));
        if (url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt') return new Response('nope', { status: 404 });
        if (url.pathname === '/') return new Response(null, { status: 301, headers: { location: 'https://example.com/home' } });
        return page('');
      })
    );
    const { snapshots } = await runCrawl(fakeDeps(), 1);
    expect(pathsOf(snapshots)).toEqual(['/home']);
  });

  it('throws only when BOTH the sitemap and the homepage crawl come up empty', async () => {
    stubHtmlRewriter();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(runCrawl(fakeDeps(), 1)).rejects.toThrow(/no pages were reachable/);
  });
});
