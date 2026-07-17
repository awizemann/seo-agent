/**
 * seo-agent — the Layer-2 adaptive SEO loop for sites fronted by the Layer-1
 * edge injector. Daily cron: self-crawl the sitemap → snapshot delivered meta
 * → run deterministic rules → draft constrained AI proposals → (optionally)
 * auto-apply via KV overrides.
 *
 * Two control surfaces over the same actions (src/actions.ts):
 *   REST (this file):    /status /run /findings /proposals[...] /changes[...] /overrides
 *   MCP  (src/mcp.ts):   /mcp — stateless Streamable HTTP for Claude clients
 *
 * Auth for both: `Authorization: Bearer <AGENT_TOKEN>` (wrangler secret).
 */

import {
  ApiError,
  runPipeline,
  statusData,
  listFindings,
  listProposals,
  decideProposal,
  createProposal,
  dryRunDraft,
  listChanges,
  revertById,
  listOverrides,
} from './actions.js';
import { invalidReason } from './propose.js';
import { handleMcp } from './mcp.js';
import { DASHBOARD_HTML } from './dashboard.js';

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

async function authorized(request: Request, env: Env): Promise<boolean> {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !env.AGENT_TOKEN) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(token)),
    crypto.subtle.digest('SHA-256', enc.encode(env.AGENT_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // The review dashboard is served UNAUTHENTICATED (no secrets in the HTML —
    // it holds a login form; the token it collects gates every API call it makes).
    if (method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
      return new Response(DASHBOARD_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'",
        },
      });
    }

    // Everything else (REST + MCP) requires the bearer token.
    if (!(await authorized(request, env))) return json({ error: 'unauthorized' }, 401);

    if (pathname === '/mcp') return handleMcp(request, env);

    try {
      if (method === 'GET' && pathname === '/status') return json(await statusData(env));
      if (method === 'POST' && pathname === '/run') return json(await runPipeline(env));
      if (method === 'GET' && pathname === '/findings') return json(await listFindings(env, url.searchParams.get('status') || 'open'));
      if (method === 'GET' && pathname === '/proposals') return json(await listProposals(env, url.searchParams.get('status') || 'proposed'));

      // Manual proposal creation — e.g. promoting a dry-run winner. Goes
      // through the same validation, approval gate, and journal as AI drafts.
      if (method === 'POST' && pathname === '/proposals') {
        const body = (await request.json()) as { path?: string; field?: string; value?: string; rationale?: string };
        return json(await createProposal(env, body, invalidReason));
      }

      // Diagnostics: run the AI draft for one page and return raw output +
      // validation verdicts without persisting anything.
      if (method === 'POST' && pathname === '/proposals/dry-run') {
        const body = (await request.json()) as { path?: string };
        return json(await dryRunDraft(env, body.path));
      }

      const proposalAction = pathname.match(/^\/proposals\/(\d+)\/(approve|reject)$/);
      if (method === 'POST' && proposalAction) {
        return json(await decideProposal(env, parseInt(proposalAction[1], 10), proposalAction[2] as 'approve' | 'reject'));
      }

      if (method === 'GET' && pathname === '/changes') return json(await listChanges(env));

      const revertAction = pathname.match(/^\/changes\/(\d+)\/revert$/);
      if (method === 'POST' && revertAction) {
        return json(await revertById(env, parseInt(revertAction[1], 10)));
      }

      if (method === 'GET' && pathname === '/overrides') return json(await listOverrides(env));

      return json({ error: 'not found' }, 404);
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message }, err.status);
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ evt: 'api_error', pathname, error: message }));
      return json({ error: message }, 500);
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runPipeline(env)
        .then((result) => console.log(JSON.stringify({ evt: 'cron_complete', ...result })))
        .catch((err) =>
          console.error(JSON.stringify({ evt: 'cron_error', error: err instanceof Error ? err.message : String(err) }))
        )
    );
  },
} satisfies ExportedHandler<Env>;
