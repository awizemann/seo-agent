import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../injector/src/index';

// Markdown TWINS from resource overrides. The origin always wins: these only
// cover what happens when it has no twin of its own.

function fakeKv(entries: Record<string, string>) {
  return {
    get: vi.fn(async (key: string) => (key in entries ? entries[key] : null)),
  };
}

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
const MD_ACCEPT = { accept: 'text/markdown, text/html' };
const twinValue = (body: string) => JSON.stringify({ contentType: 'text/markdown; charset=utf-8', body });

/** Origin router: markdown for the listed twin paths, HTML otherwise, 404 for
 *  any `.md` path that isn't listed. */
function originFetch(twins: Record<string, string> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    if (path in twins) return new Response(twins[path], { status: 200, headers: { 'content-type': 'text/markdown' } });
    if (path.endsWith('.md')) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response('<html><head><title>t</title></head></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  });
}

describe('injector markdown twins — Accept lane', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves the ORIGIN's twin and never looks up an override", async () => {
    vi.stubGlobal('fetch', originFetch({ '/a.md': '# origin twin' }));
    const kv = fakeKv({ 'resource:/a.md': twinValue('# ours') });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/a', { headers: MD_ACCEPT }), env, fakeCtx());
    expect(await res.text()).toBe('# origin twin');
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('serves the published twin when the origin 404s it', async () => {
    vi.stubGlobal('fetch', originFetch());
    const kv = fakeKv({ 'resource:/a.md': twinValue('# ours') });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/a', { headers: MD_ACCEPT }), env, fakeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# ours');
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('x-markdown-tokens')).toBe('2');
    expect(res.headers.get('content-signal')).toBe('ai-train=yes, search=yes, ai-input=yes');
    expect(res.headers.get('vary')).toBe('accept');
    expect(kv.get).toHaveBeenCalledWith('resource:/a.md', { cacheTtl: 300 });
  });

  it('derives index.md for a trailing-slash URL', async () => {
    vi.stubGlobal('fetch', originFetch());
    const kv = fakeKv({ 'resource:/section/index.md': twinValue('# section') });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/section/', { headers: MD_ACCEPT }), env, fakeCtx());
    expect(await res.text()).toBe('# section');
  });

  it('returns headers only for a HEAD request', async () => {
    vi.stubGlobal('fetch', originFetch());
    const kv = fakeKv({ 'resource:/a.md': twinValue('# ours') });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/a', { method: 'HEAD', headers: MD_ACCEPT }), env, fakeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('x-markdown-tokens')).toBe('2');
  });

  it('proxies normally when neither the origin nor an override has a twin', async () => {
    const fetchMock = originFetch();
    vi.stubGlobal('fetch', fetchMock);
    const env = { ...baseEnv, SEO_OVERRIDES: fakeKv({}) } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/a', { headers: MD_ACCEPT }), env, fakeCtx());
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('never looks a twin up without the Accept header', async () => {
    vi.stubGlobal('fetch', originFetch());
    const kv = fakeKv({ 'resource:/a.md': twinValue('# ours') });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;

    await worker.fetch(new Request('https://example.com/a'), env, fakeCtx());
    expect(kv.get.mock.calls.some(([k]) => String(k).startsWith('resource:'))).toBe(false);
  });

  it('MARKDOWN_LANE="false" disables the twin fallback too', async () => {
    vi.stubGlobal('fetch', originFetch());
    const kv = fakeKv({ 'resource:/a.md': twinValue('# ours') });
    const env = { ...baseEnv, MARKDOWN_LANE: 'false', SEO_OVERRIDES: kv } as unknown as Env;

    await worker.fetch(new Request('https://example.com/a', { headers: MD_ACCEPT }), env, fakeCtx());
    expect(kv.get.mock.calls.some(([k]) => String(k).startsWith('resource:'))).toBe(false);
  });

  it('fails open to the origin when the twin lookup throws', async () => {
    vi.stubGlobal('fetch', originFetch());
    const kv = {
      get: vi.fn(async () => {
        throw new Error('kv down');
      }),
    };
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/a', { headers: MD_ACCEPT }), env, fakeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('taps the served twin as the md lane', async () => {
    vi.stubGlobal('fetch', originFetch());
    const tap = fakeTelemetry();
    const kv = fakeKv({ 'resource:/a.md': twinValue('# ours') });
    const env = { ...baseEnv, SEO_OVERRIDES: kv, TELEMETRY: tap.db } as unknown as Env;

    await worker.fetch(new Request('https://example.com/a', { headers: { ...MD_ACCEPT, 'user-agent': 'GPTBot/1.0' } }), env, fakeCtx());
    // (ts, kind, bot, referrer, path, status, served, ua)
    expect(tap.rows).toHaveLength(1);
    expect(tap.rows[0][1]).toBe('crawler');
    expect(tap.rows[0][4]).toBe('/a');
    expect(tap.rows[0][6]).toBe('md');
  });
});

describe('injector markdown twins — direct .md fetches', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('serves the published twin when the origin 404s a literal .md URL', async () => {
    vi.stubGlobal('fetch', originFetch());
    const kv = fakeKv({ 'resource:/a.md': twinValue('# ours') });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/a.md'), env, fakeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# ours');
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  it('leaves an origin-served .md alone (no lookup)', async () => {
    vi.stubGlobal('fetch', originFetch({ '/a.md': '# origin twin' }));
    const kv = fakeKv({ 'resource:/a.md': twinValue('# ours') });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/a.md'), env, fakeCtx());
    expect(await res.text()).toBe('# origin twin');
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('passes a 404 through when no twin is published', async () => {
    vi.stubGlobal('fetch', originFetch());
    const env = { ...baseEnv, SEO_OVERRIDES: fakeKv({}) } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/a.md'), env, fakeCtx());
    expect(res.status).toBe(404);
  });

  it('honours the resource bypass header', async () => {
    vi.stubGlobal('fetch', originFetch());
    const kv = fakeKv({ 'resource:/a.md': twinValue('# ours') });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/a.md', { headers: { 'x-seo-agent-bypass': 'resource' } }), env, fakeCtx());
    expect(res.status).toBe(404);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('never looks up a twin for a non-.md 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } }))
    );
    const kv = fakeKv({ 'resource:/a.md': twinValue('# ours') });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;

    await worker.fetch(new Request('https://example.com/a.html'), env, fakeCtx());
    expect(kv.get).not.toHaveBeenCalled();
  });
});

describe('injector markdown twins — remote mode', () => {
  afterEach(() => vi.unstubAllGlobals());

  const remoteEnv = {
    ORIGIN_HOST: 'origin.example.com',
    OVERRIDES_URL: 'https://cloud.example.com/edge/site-1',
    EDGE_TOKEN: 'tok-1',
  } as unknown as Env;

  function stubCaches() {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async (req: Request) => store.get(req.url)),
        put: vi.fn(async (req: Request, res: Response) => void store.set(req.url, res)),
      },
    });
  }

  it('asks the /resource endpoint for the twin path with the bearer', async () => {
    stubCaches();
    const origin = originFetch();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/resource?path=')) {
        return url.includes('%2Fa.md')
          ? new Response(JSON.stringify({ contentType: 'text/markdown; charset=utf-8', body: '# remote twin' }), { status: 200 })
          : new Response(null, { status: 404 });
      }
      return origin(input, init as never);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await worker.fetch(new Request('https://example.com/a', { headers: MD_ACCEPT }), remoteEnv, fakeCtx());
    expect(await res.text()).toBe('# remote twin');
    const call = fetchMock.mock.calls.find(([i]) => String(i).includes('/resource?path=%2Fa.md'));
    expect(call).toBeTruthy();
    expect(((call![1] as RequestInit).headers as Record<string, string>).authorization).toBe('Bearer tok-1');
  });

  it('a 404 from the cloud falls through to normal proxying', async () => {
    stubCaches();
    const origin = originFetch();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes('/resource?path=') ? new Response(null, { status: 404 }) : origin(input, init as never)
      )
    );

    const res = await worker.fetch(new Request('https://example.com/a', { headers: MD_ACCEPT }), remoteEnv, fakeCtx());
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
