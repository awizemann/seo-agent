/**
 * Proxy injector — the standalone injector for sites you can't add middleware
 * to (a static Pages/S3/origin behind Cloudflare). Deploy it on a route in
 * FRONT of the site; it proxies every request to the origin and, for HTML
 * responses, merges the seo-agent's KV overrides into the page <head> with
 * HTMLRewriter. No changes to the origin are required.
 *
 * Contract (shared with the agent): the agent writes `override:<pathname>` →
 * JSON `{ "title"?, "description"? }`; this Worker patches the matching tags
 * (title + og:title + twitter:title, description + og:description +
 * twitter:description) only when an override exists, otherwise it proxies the
 * origin byte-for-byte.
 *
 * Resource overrides: the agent also writes `resource:<pathname>` → JSON
 * `{ "contentType", "body" }` for a small, fixed set of well-known paths
 * (RESOURCE_PATHS — /llms.txt, /llms-full.txt and /robots.txt). A GET/HEAD to
 * one of those paths checks for a resource override BEFORE contacting the
 * origin; if found, it's served directly (never proxied). No override →
 * normal proxying, so an origin that serves its own llms.txt is never
 * shadowed by a false 404. A request carrying `x-seo-agent-bypass: resource`
 * skips that lookup entirely and is proxied to the origin — how the agent reads
 * the origin's real file when regenerating one.
 *
 * Markdown twins: the agent can also publish `resource:<path>.md` for any page
 * (the `md_twin` field). The markdown lane consults it only AFTER the origin
 * declines to serve its own twin, so an origin that generates twins is never
 * shadowed, and ordinary traffic pays nothing — the lookup happens only on a
 * request that asked for markdown, or on a literal `.md` URL the origin 404'd.
 *
 * FAIL-OPEN: any error serves the origin response untouched, so the injector
 * can never take the fronted site down. Zero dependencies.
 *
 * Config (wrangler vars/bindings — see wrangler.example.jsonc):
 *   ORIGIN_HOST    var  — host to proxy to, e.g. "eo-timeline.pages.dev"
 *   SEO_OVERRIDES  KV   — the SAME namespace the seo-agent writes to
 *   routes         — the hostname to front, e.g. "eo.example.com/*"
 */

type Override = { title?: string; description?: string };

// Fixed allowlist of well-known resource paths — a BEFORE-origin resource
// lookup only ever happens for these, so ordinary traffic pays no extra
// KV/fetch cost. (Markdown twins are looked up too, but only after the
// markdown lane triggered or a `.md` URL 404'd at the origin.)
const RESOURCE_PATHS = ['/llms.txt', '/llms-full.txt', '/robots.txt'];

type ResourceOverride = { contentType: string; body: string };

// ---------------------------------------------------------------------------
// AEO telemetry tap (optional) — bind the seo-agent's D1 database as TELEMETRY
// and the injector records AI-relevant traffic into its `aeo_hits` table:
// known AI-crawler UAs, human referrals from AI engines, and markdown-lane
// responses. Nothing else is ever recorded. Fire-and-forget via waitUntil and
// swallowed errors: telemetry can never affect serving. No binding → no-op.
// ---------------------------------------------------------------------------

type D1Lite = { prepare(q: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };

const AI_BOT_RE =
  /GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-User|Claude-SearchBot|claude-web|anthropic-ai|PerplexityBot|Perplexity-User|meta-externalagent|meta-externalfetcher|Meta-WebIndexer|Amazonbot|CCBot|Bytespider|MistralAI-User|DuckAssistBot|YouBot|LinerBot|Applebot(?!-Extended)/i;
const AI_REFERRER_RE =
  /chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|bard\.google\.com|copilot\.microsoft\.com|copilot\.com|grok\.com|meta\.ai|deepseek\.com|you\.com|poe\.com/i;

function tapAeo(env: Env, ctx: ExecutionContext, request: Request, path: string, status: number, served: string): void {
  try {
    const db = (env as Env & { TELEMETRY?: D1Lite }).TELEMETRY;
    const remoteUrl = (env as Env & { TELEMETRY_URL?: string; EDGE_TOKEN?: string }).TELEMETRY_URL;
    if (!db && !remoteUrl) return;
    const ua = request.headers.get('user-agent') || '';
    if (/seo-agent/i.test(ua)) return; // the agent's own crawler/sampler — never self-count
    const bot = ua.match(AI_BOT_RE)?.[0] ?? null;
    let refHost: string | null = null;
    const ref = request.headers.get('referer');
    if (ref && AI_REFERRER_RE.test(ref)) {
      try {
        refHost = new URL(ref).hostname;
      } catch {
        refHost = null;
      }
    }
    if (!bot && !refHost && served !== 'md') return;
    const kind = bot ? 'crawler' : refHost ? 'referral' : 'agent';
    if (db) {
      ctx.waitUntil(
        db
          .prepare('INSERT INTO aeo_hits (ts, kind, bot, referrer, path, status, served, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(new Date().toISOString(), kind, bot, refHost, path, status, served, ua.slice(0, 200))
          .run()
          .catch(() => {})
      );
    } else if (remoteUrl) {
      const token = (env as Env & { EDGE_TOKEN?: string }).EDGE_TOKEN;
      ctx.waitUntil(
        fetch(remoteUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ ts: new Date().toISOString(), kind, bot, referrer: refHost, path, status, served, ua: ua.slice(0, 200) }),
        }).catch(() => {})
      );
    }
  } catch {
    // telemetry must never affect serving
  }
}

// ---------------------------------------------------------------------------
// Remote mode (optional) — for split infrastructure where the agent's KV/D1
// can't be bound from this zone (agent in another account, or a hosted
// service managing overrides). Vars instead of bindings:
//   OVERRIDES_URL — fetch `${OVERRIDES_URL}/override?path=<pathname>` over
//                   HTTPS; JSON contract unchanged; 404 = no override. Cached
//                   at this Worker's edge (Cache API, 300s) to match the KV
//                   cacheTtl behavior. A KV binding, when present, wins.
//   EDGE_TOKEN    — bearer sent with both remote calls.
//   TELEMETRY_URL — POST aeo_hits rows there instead of the TELEMETRY D1
//                   binding (same fire-and-forget, never affects serving).
// ---------------------------------------------------------------------------

type RemoteEnv = Env & { OVERRIDES_URL?: string; EDGE_TOKEN?: string; TELEMETRY_URL?: string };

async function readOverrideRemote(env: RemoteEnv, pathname: string, ctx: ExecutionContext): Promise<Override | null> {
  const url = `${env.OVERRIDES_URL!.replace(/\/$/, '')}/override?path=${encodeURIComponent(pathname || '/')}`;
  const cache = caches.default;
  const cacheKey = new Request(url); // token deliberately not part of the key
  let res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(url, {
      headers: env.EDGE_TOKEN ? { authorization: `Bearer ${env.EDGE_TOKEN}` } : undefined,
    });
    // Cache 200s AND 404s so paths without overrides don't refetch per request.
    if (res.status === 200 || res.status === 404) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set('cache-control', 'public, max-age=300');
      ctx.waitUntil(cache.put(cacheKey, copy));
    }
  }
  if (res.status !== 200) return null;
  const o = (await res.json()) as Override;
  return o.title || o.description ? o : null;
}

async function readOverride(env: Env, pathname: string, ctx: ExecutionContext): Promise<Override | null> {
  try {
    const kv = (env as { SEO_OVERRIDES?: KVNamespace }).SEO_OVERRIDES;
    if (kv) {
      const raw = await kv.get(`override:${pathname || '/'}`, { cacheTtl: 300 });
      if (!raw) return null;
      const o = JSON.parse(raw) as Override;
      return o.title || o.description ? o : null;
    }
    if ((env as RemoteEnv).OVERRIDES_URL) return await readOverrideRemote(env as RemoteEnv, pathname, ctx);
    return null;
  } catch {
    return null; // fail-open: no override applied
  }
}

// Resource overrides — same KV-wins-over-remote precedence and same 300s
// cache-incl-404 pattern as the head-tag overrides above, but the value is
// served as the whole response body instead of being merged into HTML.
async function readResourceOverrideRemote(env: RemoteEnv, pathname: string, ctx: ExecutionContext): Promise<ResourceOverride | null> {
  const url = `${env.OVERRIDES_URL!.replace(/\/$/, '')}/resource?path=${encodeURIComponent(pathname || '/')}`;
  const cache = caches.default;
  const cacheKey = new Request(url); // token deliberately not part of the key
  let res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(url, {
      headers: env.EDGE_TOKEN ? { authorization: `Bearer ${env.EDGE_TOKEN}` } : undefined,
    });
    // Cache 200s AND 404s so paths without overrides don't refetch per request.
    if (res.status === 200 || res.status === 404) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set('cache-control', 'public, max-age=300');
      ctx.waitUntil(cache.put(cacheKey, copy));
    }
  }
  if (res.status !== 200) return null;
  const o = (await res.json()) as ResourceOverride;
  return o && o.contentType && typeof o.body === 'string' ? o : null;
}

async function readResourceOverride(env: Env, pathname: string, ctx: ExecutionContext): Promise<ResourceOverride | null> {
  try {
    const kv = (env as { SEO_OVERRIDES?: KVNamespace }).SEO_OVERRIDES;
    if (kv) {
      const raw = await kv.get(`resource:${pathname || '/'}`, { cacheTtl: 300 });
      if (!raw) return null;
      const o = JSON.parse(raw) as ResourceOverride;
      return o && o.contentType && typeof o.body === 'string' ? o : null;
    }
    if ((env as RemoteEnv).OVERRIDES_URL) return await readResourceOverrideRemote(env as RemoteEnv, pathname, ctx);
    return null;
  } catch {
    return null; // fail-open: no override applied, falls through to normal proxying
  }
}

function inject(res: Response, o: Override): Response {
  const setContent = (value: string) => ({
    element(el: { setAttribute(n: string, v: string): void }) {
      el.setAttribute('content', value);
    },
  });
  let rw = new HTMLRewriter();
  if (o.title) {
    rw = rw
      // `head > title` so a title override can't overwrite an inline-SVG
      // <title> (the accessible name) in the body — bare `title` matches both.
      .on('head > title', { element: (el) => { el.setInnerContent(o.title!); } })
      .on('meta[property="og:title"]', setContent(o.title))
      .on('meta[name="twitter:title"]', setContent(o.title));
  }
  if (o.description) {
    rw = rw
      .on('meta[name="description"]', setContent(o.description))
      .on('meta[property="og:description"]', setContent(o.description))
      .on('meta[name="twitter:description"]', setContent(o.description));
  }
  return rw.transform(res);
}

// Default markdown-lane policy header, matching the main site worker's tap.
const CONTENT_SIGNAL = 'ai-train=yes, search=yes, ai-input=yes';

/**
 * The twin path for a clean URL: `/a/b` → `/a/b.md`, `/a/b/` → `/a/b/index.md`.
 *
 * MIRRORED, not imported: this Worker is zero-dependency by design (it deploys
 * from this single file, in a different zone/account from the agent). The
 * agent's `md_twin` resource field derives the SAME path — see `mdTwinPath` in
 * src/overrides.ts. Change one, change the other, or a published twin lands on
 * a key the lane never looks up.
 */
function twinPath(pathname: string): string {
  return pathname.endsWith('/') ? `${pathname}index.md` : `${pathname}.md`;
}

/** A markdown-lane response: identical headers whether the body came from the
 *  origin's own twin or from a published `resource:<path>.md` override. */
function markdownResponse(body: string, isHead: boolean, contentType?: string): Response {
  return new Response(isHead ? null : body, {
    headers: {
      'content-type': contentType || 'text/markdown; charset=utf-8',
      'x-markdown-tokens': String(Math.ceil(body.length / 4)),
      'content-signal': CONTENT_SIGNAL,
      vary: 'accept',
    },
  });
}

/** Append a token to Vary without dropping any value the origin already set. */
function appendVary(headers: Headers, token: string): void {
  const existing = headers.get('vary');
  if (!existing) {
    headers.set('vary', token);
    return;
  }
  if (!existing.split(',').some((v) => v.trim().toLowerCase() === token.toLowerCase())) {
    headers.set('vary', `${existing}, ${token}`);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const originUrl = `https://${env.ORIGIN_HOST}${url.pathname}${url.search}`;
    // Clone up front so the fail-open catch can re-issue the origin request even
    // after the primary fetch consumed request's body (a POST/PUT with a body).
    const fallback = request.clone();
    try {
      // Resource overrides: only for the fixed allowlist, and only GET/HEAD —
      // no lookup tax on other paths or methods. Checked before the markdown
      // lane and before the origin fetch: a hit is served directly and never
      // touches the origin.
      // `x-seo-agent-bypass: resource` asks for the ORIGIN's own file instead of
      // whatever we publish over it. The agent's robots.txt/llms.txt generators
      // send it: they must append to the origin's CURRENT bytes, and a fetch
      // answered by our own last override would append to itself and silently
      // drop everything the owner changed since. Safe to honour from anyone —
      // it only ever serves the public file the origin already serves.
      const bypassResource = (request.headers.get('x-seo-agent-bypass') || '').trim().toLowerCase() === 'resource';
      const isHeadMethod = request.method === 'HEAD';
      if (!bypassResource && (request.method === 'GET' || isHeadMethod) && RESOURCE_PATHS.includes(url.pathname)) {
        const resource = await readResourceOverride(env, url.pathname, ctx);
        if (resource) {
          tapAeo(env, ctx, request, url.pathname, 200, 'file');
          return new Response(isHeadMethod ? null : resource.body, {
            status: 200,
            headers: {
              'content-type': resource.contentType,
              'cache-control': 'public, max-age=300',
            },
          });
        }
        // No override → fall through to normal proxying below; the origin
        // may legitimately serve its own file at this path.
      }

      // Markdown lane ("markdown for agents"): a GET or HEAD that accepts
      // text/markdown on a clean URL is answered with the origin's pregenerated
      // .md twin when one exists (/eo/x → /eo/x.md), with Cloudflare-compatible
      // headers. Browsers never send that Accept value; anything without a twin
      // falls through to the normal proxy. MARKDOWN_LANE="false" disables.
      const mdEnv = env as Env & { MARKDOWN_LANE?: string };
      const isHead = request.method === 'HEAD';
      const mdLaneOn = !/^(false|0|off)$/i.test(mdEnv.MARKDOWN_LANE ?? '');
      const wantsMd =
        (request.method === 'GET' || isHead) &&
        mdLaneOn &&
        (request.headers.get('accept') || '').includes('text/markdown') &&
        !/\.[A-Za-z0-9]+$/.test(url.pathname);
      if (wantsMd) {
        const mdPath = twinPath(url.pathname);
        try {
          const mdRes = await fetch(`https://${env.ORIGIN_HOST}${mdPath}`, {
            headers: { 'user-agent': request.headers.get('user-agent') || 'seo-agent-injector' },
          });
          if (mdRes.ok && !(mdRes.headers.get('content-type') || '').includes('text/html')) {
            const body = await mdRes.text();
            tapAeo(env, ctx, request, url.pathname, 200, 'md');
            // HEAD: same headers as GET, no body.
            return markdownResponse(body, isHead);
          }
        } catch {
          // fall through to the override check, then the normal proxy
        }
        // The ORIGIN ALWAYS WINS: only when it has no twin (404, HTML shell,
        // fetch error) do we look for a published one at `resource:<twin>`.
        // This is the only extra lookup the lane ever costs, and it happens
        // solely on requests that already asked for markdown.
        if (!bypassResource) {
          const twin = await readResourceOverride(env, mdPath, ctx);
          if (twin) {
            tapAeo(env, ctx, request, url.pathname, 200, 'md');
            return markdownResponse(twin.body, isHead, twin.contentType);
          }
        }
      }

      const res = await fetch(new Request(originUrl, request));
      const contentType = res.headers.get('content-type') || '';

      // Direct `.md` fetches: agents request twin URLs literally, not only via
      // Accept negotiation. When the origin has no such file, a published twin
      // answers instead — same headers, same telemetry lane. Costs a lookup
      // only on a request that already 404'd for a `.md` path.
      if (
        mdLaneOn &&
        !bypassResource &&
        (request.method === 'GET' || isHeadMethod) &&
        res.status === 404 &&
        url.pathname.toLowerCase().endsWith('.md')
      ) {
        const twin = await readResourceOverride(env, url.pathname, ctx);
        if (twin) {
          tapAeo(env, ctx, request, url.pathname, 200, 'md');
          return markdownResponse(twin.body, isHeadMethod, twin.contentType);
        }
      }

      // Only HTML pages carry the meta we patch; assets/sitemap/robots stream
      // through. A markdown file served directly by the origin (a direct .md
      // fetch, or upstream Accept negotiation) taps as 'md', not 'file'.
      if (!contentType.includes('text/html')) {
        tapAeo(env, ctx, request, url.pathname, res.status, contentType.includes('text/markdown') ? 'md' : 'file');
        return res;
      }

      tapAeo(env, ctx, request, url.pathname, res.status, 'html');
      const override = await readOverride(env, url.pathname, ctx);
      // The same URL can serve markdown via Accept negotiation, so an HTML
      // response varies by Accept — even when we pass it through untouched.
      if (!override) {
        const headers = new Headers(res.headers);
        appendVary(headers, 'accept');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }

      const rewritten = inject(res, override);
      const headers = new Headers(rewritten.headers);
      // The body is transformed, so the origin's validators and encoding no
      // longer describe it: HTMLRewriter emits decompressed, re-chunked output.
      // Dropping content-encoding/length lets Cloudflare re-compress correctly
      // to the client; keeping them would double-encode or truncate the page.
      headers.delete('etag');
      headers.delete('last-modified');
      headers.delete('content-encoding');
      headers.delete('content-length');
      appendVary(headers, 'accept');
      return new Response(rewritten.body, { status: res.status, statusText: res.statusText, headers });
    } catch (err) {
      console.error(JSON.stringify({ evt: 'injector_fail_open', error: err instanceof Error ? err.message : String(err) }));
      return fetch(originUrl, fallback); // fail-open: serve the origin with an unconsumed body
    }
  },
} satisfies ExportedHandler<Env>;
