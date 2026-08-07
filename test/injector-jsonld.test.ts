import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../injector/src/index';
import { checkJsonLd } from '../src/overrides';

// JSON-LD injection. The injector is the ONE place a <script type="application/
// ld+json"> wrapper is added — KV holds the bare document — so these tests are
// the contract for placement, typing and additive behaviour.
//
// HTMLRewriter only exists on workerd, so these run against the same kind of
// minimal stand-in test/crawl-fallback.test.ts uses: it honours exactly the
// selectors and element methods the injector calls, and models `append` as
// "insert as the last child of <head>", which is what HTMLRewriter's append
// does. It is a model of the platform, not the platform — so the assertions
// here are about WHAT the injector asks for (one ld+json script, in head,
// after the origin's own markup), never about parser edge cases like an
// implicitly closed </head>, which only workerd can answer.

function stubHtmlRewriter() {
  class FakeRewriter {
    private handlers: [string, any][] = [];
    on(selector: string, handlers: any) {
      this.handlers.push([selector, handlers]);
      return this;
    }
    /** Real HTMLRewriter.transform is synchronous and streams; this returns a
     *  Response whose body resolves once the rewrite is applied, so the
     *  injector's `new Response(rewritten.body, …)` works unchanged. */
    transform(res: Response): Response {
      const self = this;
      const rewritten = (async () => {
          let html = await res.text();
          for (const [selector, h] of self.handlers) {
            if (!h.element) continue;
            if (selector === 'head') {
              // HTMLRewriter's append() inserts as head's LAST child.
              h.element({
                append: (content: string) => {
                  html = html.replace('</head>', `${content}</head>`);
                },
              });
            } else if (selector === 'head > title') {
              h.element({
                setInnerContent: (v: string) => {
                  html = html.replace(/(<title>)[\s\S]*?(<\/title>)/, `$1${v}$2`);
                },
              });
            } else {
              // meta[name="…"] / meta[property="…"] — patch the content attribute.
              const attr = selector.match(/\[(name|property)="([^"]+)"\]/);
              if (!attr) continue;
              const tagRe = new RegExp(`<meta\\b[^>]*${attr[1]}="${attr[2]}"[^>]*>`, 'g');
              for (const tag of html.match(tagRe) ?? []) {
                h.element({
                  setAttribute: (n: string, v: string) => {
                    html = html.replace(tag, tag.replace(new RegExp(`${n}="[^"]*"`), `${n}="${v}"`));
                  },
                });
              }
            }
          }
          return html;
      })();
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode(await rewritten));
            controller.close();
          },
        }),
        { status: res.status, statusText: res.statusText, headers: res.headers }
      );
    }
  }
  vi.stubGlobal('HTMLRewriter', FakeRewriter);
}

function fakeKv(entries: Record<string, string>) {
  return { get: vi.fn(async (key: string) => (key in entries ? entries[key] : null)) };
}

function fakeCtx(): ExecutionContext {
  return { waitUntil: vi.fn((p: Promise<unknown>) => void p), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

const baseEnv = { ORIGIN_HOST: 'origin.example.com' };

/** The canonical stored form, exactly as the agent would have written it. */
const stored = (doc: unknown): string => {
  const check = checkJsonLd(JSON.stringify(doc));
  if (!check.ok) throw new Error(`test fixture is not publishable: ${check.reason}`);
  return check.value;
};

const ARTICLE = { '@context': 'https://schema.org', '@type': 'Article', headline: 'How caching works' };

const PLAIN = '<html><head><title>Origin</title><meta name="description" content="d"></head><body><p>hi</p></body></html>';

function originHtml(html: string) {
  return vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
}

/** Every ld+json block in a served document, as parsed objects. */
function blocks(html: string): unknown[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

async function serve(html: string, override: Record<string, string>) {
  vi.stubGlobal('fetch', originHtml(html));
  stubHtmlRewriter();
  const kv = fakeKv({ 'override:/articles/a': JSON.stringify(override) });
  const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;
  const res = await worker.fetch(new Request('https://example.com/articles/a'), env, fakeCtx());
  return { res, body: await res.text() };
}

describe('injector — JSON-LD', () => {
  beforeEach(() => stubHtmlRewriter());
  afterEach(() => vi.unstubAllGlobals());

  it('adds a correctly typed ld+json script to a page that had none', async () => {
    const { res, body } = await serve(PLAIN, { jsonld: stored(ARTICLE) });
    expect(res.status).toBe(200);
    expect(body).toContain('<script type="application/ld+json">');
    expect(blocks(body)).toEqual([ARTICLE]);
  });

  it('places it inside <head>, as the last thing before </head>', async () => {
    const { body } = await serve(PLAIN, { jsonld: stored(ARTICLE) });
    const script = body.indexOf('<script type="application/ld+json">');
    expect(script).toBeGreaterThan(body.indexOf('<head>'));
    expect(script).toBeLessThan(body.indexOf('</head>'));
    expect(body).toMatch(/<\/script><\/head>/);
  });

  it('is ADDITIVE — a page with its own JSON-LD keeps it and gets ours too', async () => {
    const existing = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme' };
    const html =
      '<html><head><title>Origin</title>' +
      `<script type="application/ld+json">${JSON.stringify(existing)}</script>` +
      '</head><body></body></html>';
    const { body } = await serve(html, { jsonld: stored(ARTICLE) });
    const found = blocks(body);
    expect(found).toHaveLength(2);
    expect(found).toContainEqual(existing);
    expect(found).toContainEqual(ARTICLE);
  });

  it('injects exactly one block', async () => {
    const { body } = await serve(PLAIN, { jsonld: stored(ARTICLE) });
    expect(blocks(body)).toHaveLength(1);
  });

  it('serves a jsonld-only override — no title or description needed to trigger it', async () => {
    const { body } = await serve(PLAIN, { jsonld: stored(ARTICLE) });
    expect(body).toContain('<title>Origin</title>'); // untouched
    expect(blocks(body)).toHaveLength(1);
  });

  it('applies alongside title and description in the same pass', async () => {
    const { body } = await serve(PLAIN, { title: 'New title', description: 'New description', jsonld: stored(ARTICLE) });
    expect(body).toContain('<title>New title</title>');
    expect(body).toContain('content="New description"');
    expect(blocks(body)).toEqual([ARTICLE]);
  });

  it('does not inject when the page has no jsonld override', async () => {
    const { body } = await serve(PLAIN, { title: 'New title' });
    expect(body).not.toContain('ld+json');
  });

  it('leaves a page with NO override untouched', async () => {
    vi.stubGlobal('fetch', originHtml(PLAIN));
    const kv = fakeKv({});
    const env = { ...baseEnv, SEO_OVERRIDES: kv } as unknown as Env;
    const res = await worker.fetch(new Request('https://example.com/articles/a'), env, fakeCtx());
    expect(await res.text()).toBe(PLAIN);
  });

  it('escapes a smuggled </script> so the block cannot be closed early', async () => {
    const evil = { ...ARTICLE, headline: '</script><img src=x onerror=alert(1)>' };
    const { body } = await serve(PLAIN, { jsonld: stored(evil) });
    // The payload survives as DATA — the headline round-trips intact — while
    // never becoming MARKUP: no `<img` tag, and the one ld+json block is closed
    // by the wrapper we wrote, not by the payload.
    expect(blocks(body)).toEqual([evil]);
    expect(body).not.toContain('<img');
    expect(body.match(/<\/script>/g)).toHaveLength(1);
    expect(body).toContain('\\u003c');
  });

  it('SKIPS a hand-written KV value carrying a raw `<` — the edge publishes nothing rather than markup', async () => {
    // Not a value this agent can produce (checkJsonLd escapes it), but this
    // Worker reads a namespace it does not exclusively own.
    const { body } = await serve(PLAIN, { jsonld: '{"@context":"https://schema.org","@type":"Article","x":"</script><img src=x>"}' });
    expect(body).not.toContain('ld+json');
    expect(body).not.toContain('<img src=x>');
  });

  it('injects in remote mode too, over the same JSON contract', async () => {
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } } as unknown as CacheStorage);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('/override?path=')) {
          return new Response(JSON.stringify({ jsonld: stored(ARTICLE) }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(PLAIN, { status: 200, headers: { 'content-type': 'text/html' } });
      })
    );
    const env = { ...baseEnv, OVERRIDES_URL: 'https://agent.example.com' } as unknown as Env;
    const res = await worker.fetch(new Request('https://example.com/articles/a'), env, fakeCtx());
    expect(blocks(await res.text())).toEqual([ARTICLE]);
  });
});
