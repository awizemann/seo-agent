import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../injector/src/index';
import { invalidOgImageReason, storedOverrideValue, applyOverride, OVERRIDE_FIELDS } from '../src/overrides';
import { currentValueFor } from '../src/propose';
import { createProposal } from '../src/actions';
import { verifyOverrides } from '../src/verify';
import { resolveSiteConfig } from '../src/config';

// The og:image lane: a CHOSEN value (never drafted, never computed) riding the
// manual proposal path, published by the injector as og:image + twitter:image
// with rewrite-or-insert semantics.

const config = resolveSiteConfig({ SITE_URL: 'https://example.com', SITE_NAME: 'Acme' });

describe('invalidOgImageReason', () => {
  it('accepts an absolute image URL — query strings and foreign (CDN) hosts included', () => {
    expect(invalidOgImageReason('https://example.com/hero.png')).toBeNull();
    expect(invalidOgImageReason('https://cdn.example.net/img/hero.jpg?w=1200&fm=jpg')).toBeNull();
  });

  it('rejects what could break the attribute or is not a fetchable image URL', () => {
    expect(invalidOgImageReason('')).toMatch(/empty/);
    expect(invalidOgImageReason('/hero.png')).toMatch(/absolute/);
    expect(invalidOgImageReason('javascript:alert(1)')).toMatch(/http/);
    expect(invalidOgImageReason('https://example.com/a b.png')).not.toBeNull();
    expect(invalidOgImageReason('https://example.com/a".png')).not.toBeNull();
    expect(invalidOgImageReason(`https://example.com/${'a'.repeat(2100)}`)).toMatch(/too long/);
  });
});

describe('og_image as an override field', () => {
  it('is in OVERRIDE_FIELDS; currentValueFor reads the snapshot og_image', () => {
    expect(OVERRIDE_FIELDS.has('og_image')).toBe(true);
    expect(currentValueFor('og_image', { title: 't', description: 'd', ogImage: 'https://example.com/x.png' })).toBe('https://example.com/x.png');
    expect(currentValueFor('og_image', { title: 't', description: 'd' })).toBeNull();
  });

  it('storedOverrideValue stores verbatim and throws on an invalid one', () => {
    expect(storedOverrideValue('og_image', 'https://cdn.example.net/x.png?w=1200', ' — Acme')).toBe('https://cdn.example.net/x.png?w=1200');
    expect(() => storedOverrideValue('og_image', 'not a url', undefined)).toThrow(/invalid og_image/);
  });
});

// -------------------------------------------------- manual lane + apply edge

type Row = Record<string, unknown>;
function fakeDeps() {
  const proposals: Row[] = [];
  const changes: Row[] = [];
  const store = new Map<string, string>();
  const db = {
    prepare: (sql: string) => ({
      bind: (...b: unknown[]) => ({
        first: async () => {
          if (/INSERT INTO proposals/.test(sql)) {
            const drafted = b.length === 8;
            const row = drafted
              ? { id: proposals.length + 1, path: b[2], field: b[3], current_value: b[4], proposed_value: b[5], status: 'proposed' }
              : { id: proposals.length + 1, path: b[2], field: b[3], current_value: b[4], proposed_value: b[5], status: 'proposed' };
            proposals.push(row);
            return row;
          }
          if (/SELECT 1 FROM proposals/.test(sql)) return null;
          if (/INSERT INTO changes/.test(sql)) {
            const row = { id: changes.length + 1 };
            changes.push(row);
            return row;
          }
          if (/SELECT title, description, canonical, og_image FROM page_snapshots/.test(sql)) {
            return { title: 'Pricing', description: 'd', canonical: null, og_image: null };
          }
          throw new Error(`unhandled: ${sql}`);
        },
        run: async () => ({}),
      }),
    }),
  };
  const overrides = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  return { proposals, changes, store, deps: { db, overrides, config } as any };
}

describe('createProposal — og_image', () => {
  it('accepts a valid image URL (query included) through the manual lane', async () => {
    const d = fakeDeps();
    const r = await createProposal(d.deps, { path: '/pricing', field: 'og_image', value: 'https://cdn.example.net/hero.png?w=1200' }, () => null);
    expect(r.ok).toBe(true);
    expect(d.proposals[0]).toMatchObject({ field: 'og_image', proposed_value: 'https://cdn.example.net/hero.png?w=1200' });
  });

  it('rejects an invalid one with the og_image validator', async () => {
    await expect(
      createProposal(fakeDeps().deps, { path: '/a', field: 'og_image', value: 'ftp://example.com/x.png' }, () => null)
    ).rejects.toThrow(/invalid og_image/);
  });
});

describe('applyOverride — og_image', () => {
  it('stores a valid value; refuses an invalid one at the KV edge', async () => {
    const d = fakeDeps();
    await applyOverride(d.deps, { path: '/a', field: 'og_image', value: 'https://example.com/x.png', oldValue: null, source: 'proposal' });
    expect(JSON.parse(d.store.get('override:/a')!)).toEqual({ og_image: 'https://example.com/x.png' });
    await expect(
      applyOverride(d.deps, { path: '/b', field: 'og_image', value: 'x y', oldValue: null, source: 'proposal' })
    ).rejects.toThrow(/invalid og_image/);
  });
});

describe('verifyOverrides — og_image', () => {
  const snap = (ogImage: string | null) => [{ path: '/a', status: 200, title: 't', description: 'd', canonical: null, ogImage } as any];

  it('silent on a match, critical on a page delivering nothing', () => {
    expect(verifyOverrides([{ path: '/a', og_image: 'https://example.com/x.png' }], snap('https://example.com/x.png'))).toEqual([]);
    const out = verifyOverrides([{ path: '/a', og_image: 'https://example.com/x.png' }], snap(null));
    expect(out).toHaveLength(1);
    expect(out[0].detail).toContain('og_image');
  });
});

// ------------------------------------------------------------- the injector

function stubHtmlRewriter() {
  class FakeRewriter {
    private handlers: [string, any][] = [];
    on(selector: string, handlers: any) {
      this.handlers.push([selector, handlers]);
      return this;
    }
    transform(res: Response): Response {
      const self = this;
      const rewritten = (async () => {
        let html = await res.text();
        const endTagCallbacks: Array<(end: { before(c: string, o: { html: boolean }): void }) => void> = [];
        for (const [selector, h] of self.handlers) {
          if (!h.element) continue;
          if (selector === 'head') {
            h.element({
              append: (content: string) => { html = html.replace('</head>', `${content}</head>`); },
              onEndTag: (cb: (end: { before(c: string, o: { html: boolean }): void }) => void) => { endTagCallbacks.push(cb); },
            });
          } else {
            // meta[property="…"] / meta[name="…"] — PRESENCE-GATED, like the
            // real parser: the handler only runs when the tag exists.
            const attr = selector.match(/^meta\[(name|property)="([^"]+)"\]$/);
            if (!attr) continue;
            const tagRe = new RegExp(`<meta\\b[^>]*${attr[1]}="${attr[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'g');
            for (const tag of html.match(tagRe) ?? []) {
              h.element({
                setAttribute: (n: string, v: string) => {
                  html = html.replace(tag, tag.replace(new RegExp(`${n}="[^"]*"`), `${n}="${v}"`));
                },
              });
            }
          }
        }
        for (const cb of endTagCallbacks) {
          cb({ before: (content: string) => { html = html.replace('</head>', `${content}</head>`); } });
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

const WITH_OG = '<html><head><title>T</title><meta property="og:image" content="https://old.example.com/a.png"><meta name="twitter:image" content="https://old.example.com/a.png"></head><body></body></html>';
const WITHOUT_OG = '<html><head><title>T</title><meta name="description" content="d"></head><body></body></html>';

async function serveInjector(html: string, override: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })));
  stubHtmlRewriter();
  const kv = { get: vi.fn(async (key: string) => (key === 'override:/x' ? JSON.stringify(override) : null)) };
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const env = { ORIGIN_HOST: 'origin.example.com', SEO_OVERRIDES: kv } as unknown as Env;
  const res = await worker.fetch(new Request('https://example.com/x'), env, ctx);
  return await res.text();
}

describe('injector — og_image', () => {
  beforeEach(() => stubHtmlRewriter());
  afterEach(() => vi.unstubAllGlobals());

  it('rewrites BOTH existing tags and adds neither', async () => {
    const body = await serveInjector(WITH_OG, { og_image: 'https://example.com/new.png' });
    expect(body.match(/content="https:\/\/example\.com\/new\.png"/g)).toHaveLength(2);
    expect(body.match(/og:image/g)).toHaveLength(1);
    expect(body.match(/twitter:image/g)).toHaveLength(1);
  });

  it('inserts both tags into head when the page has neither', async () => {
    const body = await serveInjector(WITHOUT_OG, { og_image: 'https://example.com/new.png' });
    expect(body).toContain('<meta property="og:image" content="https://example.com/new.png">');
    expect(body).toContain('<meta name="twitter:image" content="https://example.com/new.png">');
    expect(body.indexOf('og:image')).toBeLessThan(body.indexOf('</head>'));
  });

  it('the serve-time belt refuses hostile values, allows CDN query strings', async () => {
    for (const hostile of ['javascript:alert(1)', 'https://example.com/x" onload="x', 'https://example.com/a b.png']) {
      const body = await serveInjector(WITHOUT_OG, { og_image: hostile });
      expect(body, hostile).not.toContain('og:image');
    }
    const ok = await serveInjector(WITHOUT_OG, { og_image: 'https://cdn.example.net/x.png?w=1200' });
    expect(ok).toContain('content="https://cdn.example.net/x.png?w=1200"');
  });
});
