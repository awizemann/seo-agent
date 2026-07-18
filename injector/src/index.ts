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
      .on('title', { element: (el) => { el.setInnerContent(o.title!); } })
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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const originUrl = `https://${env.ORIGIN_HOST}${url.pathname}${url.search}`;
    try {
      const res = await fetch(new Request(originUrl, request));

      // Only HTML pages carry the meta we patch; assets/sitemap/robots stream through.
      if (!(res.headers.get('content-type') || '').includes('text/html')) return res;

      const override = await readOverride(env, url.pathname);
      if (!override) return res;

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
      return new Response(rewritten.body, { status: res.status, statusText: res.statusText, headers });
    } catch (err) {
      console.error(JSON.stringify({ evt: 'injector_fail_open', error: err instanceof Error ? err.message : String(err) }));
      return fetch(originUrl, request); // fail-open: serve the origin directly
    }
  },
} satisfies ExportedHandler<Env>;
