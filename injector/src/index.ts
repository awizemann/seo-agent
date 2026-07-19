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
 * FAIL-OPEN: any error serves the origin response untouched, so the injector
 * can never take the fronted site down. Zero dependencies.
 *
 * Config (wrangler vars/bindings — see wrangler.example.jsonc):
 *   ORIGIN_HOST    var  — host to proxy to, e.g. "eo-timeline.pages.dev"
 *   SEO_OVERRIDES  KV   — the SAME namespace the seo-agent writes to
 *   routes         — the hostname to front, e.g. "eo.example.com/*"
 */

type Override = { title?: string; description?: string };

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
    if (!db) return;
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
    ctx.waitUntil(
      db
        .prepare('INSERT INTO aeo_hits (ts, kind, bot, referrer, path, status, served, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(new Date().toISOString(), kind, bot, refHost, path, status, served, ua.slice(0, 200))
        .run()
        .catch(() => {})
    );
  } catch {
    // telemetry must never affect serving
  }
}

async function readOverride(env: Env, pathname: string): Promise<Override | null> {
  try {
    const raw = await env.SEO_OVERRIDES.get(`override:${pathname || '/'}`, { cacheTtl: 300 });
    if (!raw) return null;
    const o = JSON.parse(raw) as Override;
    return o.title || o.description ? o : null;
  } catch {
    return null; // fail-open: no override applied
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
      // Markdown lane ("markdown for agents"): a GET or HEAD that accepts
      // text/markdown on a clean URL is answered with the origin's pregenerated
      // .md twin when one exists (/eo/x → /eo/x.md), with Cloudflare-compatible
      // headers. Browsers never send that Accept value; anything without a twin
      // falls through to the normal proxy. MARKDOWN_LANE="false" disables.
      const mdEnv = env as Env & { MARKDOWN_LANE?: string };
      const isHead = request.method === 'HEAD';
      const wantsMd =
        (request.method === 'GET' || isHead) &&
        !/^(false|0|off)$/i.test(mdEnv.MARKDOWN_LANE ?? '') &&
        (request.headers.get('accept') || '').includes('text/markdown') &&
        !/\.[A-Za-z0-9]+$/.test(url.pathname);
      if (wantsMd) {
        try {
          const mdPath = url.pathname.endsWith('/') ? `${url.pathname}index.md` : `${url.pathname}.md`;
          const mdRes = await fetch(`https://${env.ORIGIN_HOST}${mdPath}`, {
            headers: { 'user-agent': request.headers.get('user-agent') || 'seo-agent-injector' },
          });
          if (mdRes.ok && !(mdRes.headers.get('content-type') || '').includes('text/html')) {
            const body = await mdRes.text();
            tapAeo(env, ctx, request, url.pathname, 200, 'md');
            // HEAD: same headers as GET, no body.
            return new Response(isHead ? null : body, {
              headers: {
                'content-type': 'text/markdown; charset=utf-8',
                'x-markdown-tokens': String(Math.ceil(body.length / 4)),
                'content-signal': CONTENT_SIGNAL,
                vary: 'accept',
              },
            });
          }
        } catch {
          // fall through to the normal proxy
        }
      }

      const res = await fetch(new Request(originUrl, request));
      const contentType = res.headers.get('content-type') || '';

      // Only HTML pages carry the meta we patch; assets/sitemap/robots stream
      // through. A markdown file served directly by the origin (a direct .md
      // fetch, or upstream Accept negotiation) taps as 'md', not 'file'.
      if (!contentType.includes('text/html')) {
        tapAeo(env, ctx, request, url.pathname, res.status, contentType.includes('text/markdown') ? 'md' : 'file');
        return res;
      }

      tapAeo(env, ctx, request, url.pathname, res.status, 'html');
      const override = await readOverride(env, url.pathname);
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
