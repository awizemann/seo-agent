import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../injector/src/index';

// Minimal fake KVNamespace — only `get` is exercised by the resource path.
function fakeKv(entries: Record<string, string>) {
  return {
    get: vi.fn(async (key: string) => (key in entries ? entries[key] : null)),
  };
}

function fakeCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

const baseEnv = { ORIGIN_HOST: 'origin.example.com' };

describe('injector resource overrides (llms.txt / llms-full.txt)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('origin body', { status: 200, headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves a KV resource override on an allowlisted path without touching the origin', async () => {
    const kv = fakeKv({ 'resource:/llms.txt': JSON.stringify({ contentType: 'text/plain; charset=utf-8', body: '# hello' }) });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;
    const req = new Request('https://example.com/llms.txt');
    const res = await worker.fetch(req, env, fakeCtx());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await res.text()).toBe('# hello');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies to origin when no override exists for an allowlisted path', async () => {
    const kv = fakeKv({});
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;
    const req = new Request('https://example.com/llms-full.txt');
    const res = await worker.fetch(req, env, fakeCtx());

    expect(fetchMock).toHaveBeenCalled();
    expect(await res.text()).toBe('origin body');
  });

  it('never performs a resource lookup for a non-allowlisted path', async () => {
    const kv = fakeKv({ 'resource:/llms.txt': JSON.stringify({ contentType: 'text/plain', body: 'x' }) });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;
    const req = new Request('https://example.com/sitemap.xml');
    await worker.fetch(req, env, fakeCtx());

    expect(kv.get).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('serves a robots.txt override, replacing the origin response entirely', async () => {
    const body = 'User-agent: *\nAllow: /\n';
    const kv = fakeKv({ 'resource:/robots.txt': JSON.stringify({ contentType: 'text/plain; charset=utf-8', body }) });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;
    const res = await worker.fetch(new Request('https://example.com/robots.txt'), env, fakeCtx());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe(body);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies robots.txt to the origin when no override is published', async () => {
    const kv = fakeKv({});
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;
    const res = await worker.fetch(new Request('https://example.com/robots.txt'), env, fakeCtx());

    expect(fetchMock).toHaveBeenCalled();
    expect(await res.text()).toBe('origin body');
  });

  it('fails open and proxies to origin on malformed override JSON', async () => {
    const kv = fakeKv({ 'resource:/llms.txt': '{ not valid json' });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;
    const req = new Request('https://example.com/llms.txt');
    const res = await worker.fetch(req, env, fakeCtx());

    expect(fetchMock).toHaveBeenCalled();
    expect(await res.text()).toBe('origin body');
  });

  it('returns headers only (no body) for a HEAD request', async () => {
    const kv = fakeKv({ 'resource:/llms.txt': JSON.stringify({ contentType: 'text/plain', body: 'full body text' }) });
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;
    const req = new Request('https://example.com/llms.txt', { method: 'HEAD' });
    const res = await worker.fetch(req, env, fakeCtx());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Remote mode — the mode a hosted service actually runs (no KV binding;
// OVERRIDES_URL + EDGE_TOKEN). Stubs caches.default alongside fetch.
// ---------------------------------------------------------------------------

function fakeCaches(prefilled: Record<string, Response> = {}) {
  const store = new Map<string, Response>(Object.entries(prefilled));
  const cache = {
    match: vi.fn(async (req: Request) => store.get(req.url)),
    put: vi.fn(async (req: Request, res: Response) => void store.set(req.url, res)),
  };
  return { cache, store };
}

const remoteEnv = {
  ORIGIN_HOST: 'origin.example.com',
  OVERRIDES_URL: 'https://cloud.example.com/edge/site-1',
  EDGE_TOKEN: 'tok-1',
} as unknown as Env;

describe('injector resource overrides — remote mode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches the /resource endpoint with the bearer and serves the body', async () => {
    const { cache } = fakeCaches();
    vi.stubGlobal('caches', { default: cache });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/resource?path=')) {
        return new Response(JSON.stringify({ contentType: 'text/markdown; charset=utf-8', body: '# remote' }), { status: 200 });
      }
      return new Response('origin body', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await worker.fetch(new Request('https://example.com/llms.txt'), remoteEnv, fakeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# remote');
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    const resourceCall = fetchMock.mock.calls.find(([i]) => String(i).includes('/resource?path=%2Fllms.txt'));
    expect(resourceCall).toBeTruthy();
    const headers = (resourceCall![1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer tok-1');
  });

  it('KV binding wins over remote mode when both are configured', async () => {
    const { cache } = fakeCaches();
    vi.stubGlobal('caches', { default: cache });
    const fetchMock = vi.fn(async () => new Response('origin body', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const kv = fakeKv({ 'resource:/llms.txt': JSON.stringify({ contentType: 'text/plain', body: 'kv wins' }) });
    const env = { ...(remoteEnv as object), SEO_OVERRIDES: kv } as unknown as Env;

    const res = await worker.fetch(new Request('https://example.com/llms.txt'), env, fakeCtx());
    expect(await res.text()).toBe('kv wins');
    // No remote /resource call was made.
    expect(fetchMock.mock.calls.some(([i]) => String(i).includes('/resource'))).toBe(false);
  });

  it('a 404 from the cloud falls through to origin proxying (no shadowing)', async () => {
    const { cache } = fakeCaches();
    vi.stubGlobal('caches', { default: cache });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/resource?path=')
        ? new Response(null, { status: 404 })
        : new Response('origin body', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await worker.fetch(new Request('https://example.com/llms.txt'), remoteEnv, fakeCtx());
    expect(await res.text()).toBe('origin body');
  });

  it('a 500 from the cloud fails open to origin proxying (tracked plan risk)', async () => {
    const { cache } = fakeCaches();
    vi.stubGlobal('caches', { default: cache });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/resource?path=')
        ? new Response('boom', { status: 500 })
        : new Response('origin body', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await worker.fetch(new Request('https://example.com/llms.txt'), remoteEnv, fakeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('origin body');
  });

  it('a cached hit is served without refetching the cloud', async () => {
    const cachedUrl = 'https://cloud.example.com/edge/site-1/resource?path=%2Fllms.txt';
    const { cache } = fakeCaches({
      [cachedUrl]: new Response(JSON.stringify({ contentType: 'text/plain', body: 'cached' }), { status: 200 }),
    });
    vi.stubGlobal('caches', { default: cache });
    const fetchMock = vi.fn(async () => new Response('origin body', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await worker.fetch(new Request('https://example.com/llms.txt'), remoteEnv, fakeCtx());
    expect(await res.text()).toBe('cached');
    expect(fetchMock.mock.calls.some(([i]) => String(i).includes('/resource'))).toBe(false);
  });
});
