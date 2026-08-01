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
    const req = new Request('https://example.com/robots.txt');
    await worker.fetch(req, env, fakeCtx());

    expect(kv.get).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
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
