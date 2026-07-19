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
  startRun,
  statusData,
  listFindings,
  dismissFinding,
  restoreFinding,
  draftFinding,
  listProposals,
  decideProposal,
  createProposal,
  dryRunDraft,
  listChanges,
  revertById,
  listOverrides,
  listAeoHits,
  listCitations,
  runCitationCheck,
} from './actions.js';
import { invalidReason, draftAndCreate, type DraftJob } from './propose.js';
import { analyticsSummary, analyticsPage, analyticsImpact } from './analytics.js';
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

/** Parse a JSON request body, mapping malformed JSON to a 400 (not a 500). */
async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError('invalid JSON body', 400);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
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

    if (pathname === '/mcp') return handleMcp(request, env, ctx);

    try {
      if (method === 'GET' && pathname === '/status') return json(await statusData(env));
      // Fire-and-return: the pipeline (crawl + AI drafting) can run well past a
      // normal request timeout, so start it in the background and let the client
      // poll /status for `running=false` + a new lastRun. 202 = started here,
      // 409 = a run was already in progress.
      if (method === 'POST' && pathname === '/run') {
        const r = await startRun(env, (p) => ctx.waitUntil(p));
        return json(r, r.started ? 202 : 409);
      }
      if (method === 'GET' && pathname === '/findings') return json(await listFindings(env, url.searchParams.get('status') || 'open'));

      // Per-finding lifecycle actions: dismiss (mute) an open finding, restore a
      // dismissed one, or enqueue an AI draft for a description-fixable finding.
      const findingAction = pathname.match(/^\/findings\/(\d+)\/(dismiss|restore|draft)$/);
      if (method === 'POST' && findingAction) {
        const fid = parseInt(findingAction[1], 10);
        if (findingAction[2] === 'dismiss') return json(await dismissFinding(env, fid));
        if (findingAction[2] === 'restore') return json(await restoreFinding(env, fid));
        return json(await draftFinding(env, fid));
      }

      if (method === 'GET' && pathname === '/proposals') return json(await listProposals(env, url.searchParams.get('status') || 'proposed'));

      // Manual proposal creation — e.g. promoting a dry-run winner. Goes
      // through the same validation, approval gate, and journal as AI drafts.
      if (method === 'POST' && pathname === '/proposals') {
        const body = await parseJsonBody<{ path?: string; field?: string; value?: string; rationale?: string }>(request);
        return json(await createProposal(env, body, invalidReason));
      }

      // Diagnostics: run the AI draft for one page and return raw output +
      // validation verdicts without persisting anything.
      if (method === 'POST' && pathname === '/proposals/dry-run') {
        const body = await parseJsonBody<{ path?: string }>(request);
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

      // AEO sensing: AI-traffic telemetry (written by the site's tap) and
      // citation-probe results/trigger.
      if (method === 'GET' && pathname === '/aeo/hits') {
        return json(await listAeoHits(env, parseInt(url.searchParams.get('days') || '7', 10) || 7));
      }
      if (method === 'GET' && pathname === '/aeo/citations') return json(await listCitations(env));
      if (method === 'POST' && pathname === '/aeo/citations/run') return json(await runCitationCheck(env));

      // Analytics: SEO/AEO metrics over time, change-impact verdicts. Read-only,
      // assembled in analytics.ts; each block degrades to empty on a DB that
      // predates the change_impact / aeo_weekly tables (never 500s).
      if (method === 'GET' && pathname === '/analytics/summary') return json(await analyticsSummary(env));
      if (method === 'GET' && pathname === '/analytics/page') return json(await analyticsPage(env, url.searchParams.get('path') || ''));
      if (method === 'GET' && pathname === '/analytics/impact') return json(await analyticsImpact(env));

      return json({ error: 'not found' }, 404);
    } catch (err) {
      if (err instanceof ApiError) return json({ error: err.message }, err.status);
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ evt: 'api_error', pathname, error: message }));
      return json({ error: message }, 500);
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    // Same start path as the API: skips if a manual run is already in progress.
    await startRun(env, (p) => ctx.waitUntil(p));
  },

  // Queue consumer (max_batch_size 1): draft one proposal per invocation, so a
  // slow/variable Workers AI call is isolated to its own message. A throw
  // retries the message (up to max_retries); success/no-op acks it.
  async queue(batch, env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await draftAndCreate(env, msg.body);
        msg.ack();
      } catch (err) {
        console.error(JSON.stringify({ evt: 'draft_job_error', path: msg.body?.path, error: err instanceof Error ? err.message : String(err) }));
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, DraftJob>;
