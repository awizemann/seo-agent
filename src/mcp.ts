/**
 * Stateless MCP server over Streamable HTTP — no SSE, no sessions, no deps.
 * Spec-compliant minimal shape (2025-06-18 transport): every JSON-RPC request
 * arrives as its own POST and gets a single application/json response;
 * notifications get 202; GET/DELETE get 405; Origin is validated. Auth is the
 * same bearer token as the REST API, enforced in index.ts before dispatch.
 *
 * Connect from Claude Code:
 *   claude mcp add --transport http seo-agent https://<worker-host>/mcp \
 *     --header "Authorization: Bearer <AGENT_TOKEN>"
 */

import {
  ApiError,
  startRun,
  statusData,
  listFindings,
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
import { invalidReason } from './propose.js';
import { analyticsSummary, analyticsImpact } from './analytics.js';
import { VERDICT_METHODOLOGY } from './impact.js';
import { VERSION } from './version.js';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_VERSION = '2025-06-18';

type Tool = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  handler: (env: Env, args: Record<string, any>, ctx: ExecutionContext) => Promise<unknown>;
};

const TOOLS: Tool[] = [
  {
    name: 'seo_status',
    description:
      'Overall state of the SEO agent: last crawl run, open findings by severity, proposals by status, applied-change counts, GSC data freshness, and active config.',
    inputSchema: { type: 'object', properties: {} },
    handler: (env) => statusData(env),
  },
  {
    name: 'run_pipeline',
    description:
      'Start a pipeline run (sitemap self-crawl → rules → enqueue drafting jobs → GSC ingest) in the background and return immediately. Returns {started, running} — started=false means a run was already in progress. Poll seo_status until running=false and lastRun.pipeline_done=1 (usually well under a minute). Meta-description drafts are produced asynchronously by a queue over the following ~1–2 min, so call list_proposals a little after the run completes to see them.',
    inputSchema: { type: 'object', properties: {} },
    handler: (env, _a, ctx) => startRun(env, (p) => ctx.waitUntil(p)),
  },
  {
    name: 'list_findings',
    description: 'List rule findings. Findings auto-resolve when their condition stops triggering on a later crawl.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'resolved'], description: 'Default: open' } },
    },
    handler: (env, a) => listFindings(env, a.status || 'open'),
  },
  {
    name: 'list_proposals',
    description: 'List AI/manual meta proposals. status=proposed are awaiting a human decision.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['proposed', 'approved', 'rejected', 'reverted'], description: 'Default: proposed' },
      },
    },
    handler: (env, a) => listProposals(env, a.status || 'proposed'),
  },
  {
    name: 'approve_proposal',
    description:
      'Approve a proposal: applies it to the live site immediately via KV override (visible within ~5 min), journals the change, and returns the change id for revert.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: (env, a) => decideProposal(env, Number(a.id), 'approve'),
  },
  {
    name: 'reject_proposal',
    description: 'Reject a proposal. The page stays proposable on future runs.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    handler: (env, a) => decideProposal(env, Number(a.id), 'reject'),
  },
  {
    name: 'create_proposal',
    description:
      'Create a manual proposal (e.g. promote a dry_run_draft winner or hand-written copy). Same validation and approval gate as AI proposals — approve it separately to apply.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Page path, e.g. /press' },
        value: { type: 'string', description: 'The proposed text' },
        field: { type: 'string', enum: ['description', 'title'], description: 'Default: description' },
        rationale: { type: 'string' },
      },
      required: ['path', 'value'],
    },
    handler: (env, a) => createProposal(env, a, invalidReason),
  },
  {
    name: 'dry_run_draft',
    description:
      'Generate one AI meta-description candidate for a page WITHOUT persisting anything. Returns the draft plus raw model output and validation verdicts. Call repeatedly for alternatives.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: (env, a) => dryRunDraft(env, a.path),
  },
  {
    name: 'list_changes',
    description: 'The journal of every override applied to the live site (and reverts), newest first, with old/new values.',
    inputSchema: { type: 'object', properties: {} },
    handler: (env) => listChanges(env),
  },
  {
    name: 'revert_change',
    description:
      'Revert an applied change: removes the override so the site falls back to its baked value, and retires the source proposal so the page becomes proposable again.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'The change id from list_changes' } }, required: ['id'] },
    handler: (env, a) => revertById(env, Number(a.id)),
  },
  {
    name: 'list_overrides',
    description: 'The current live override state (what the edge injector is merging right now), straight from KV.',
    inputSchema: { type: 'object', properties: {} },
    handler: (env) => listOverrides(env),
  },
  {
    name: 'list_crawler_hits',
    description:
      'Recent AI-traffic telemetry recorded by the site: AI crawler fetches (which bot, path, status, whether the markdown twin or AI content lane was served) and human referrals from AI engines. Empty until the site-side tap (TELEMETRY D1 binding) is wired up.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Look-back window in days (default 7, max 90)' } },
    },
    handler: (env, a) => listAeoHits(env, Number(a.days) || 7),
  },
  {
    name: 'list_citations',
    description:
      'Citation-probe results, newest first: per engine × query, whether an AI answer engine cited this site (cited/rank/cited_url). Probes run weekly on CITATION_CRON_DAY or on demand via run_citation_check.',
    inputSchema: { type: 'object', properties: {} },
    handler: (env) => listCitations(env),
  },
  {
    name: 'run_citation_check',
    description:
      'Probe the configured AI engines (Gemini free-tier by default; Perplexity/OpenAI/Anthropic when their keys are set) with every CITATION_QUERIES query right now and record who cites the site. Returns {checked, cited, errors, engines} — or a `skipped` reason when queries/keys are not configured. Costs API quota on each call.',
    inputSchema: { type: 'object', properties: {} },
    handler: (env) => runCitationCheck(env),
  },
  {
    name: 'get_analytics',
    description:
      'SEO/AEO metrics over time for the dashboard Analytics view: GSC clicks/impressions/CTR/position daily for 90d (all pages summed, active=false when GSC is off), AI-traffic daily counts (30d) + permanent weekly rollups + top AI bots (7d), citation-probe history, an open-findings-by-severity daily series (90d), and every applied change with its latest helped/hurt/neutral/insufficient_data verdict.',
    inputSchema: { type: 'object', properties: {} },
    handler: (env) => analyticsSummary(env),
  },
  {
    name: 'get_change_impact',
    description:
      'Per-change SEO impact rows (d14/d28 before/after GSC comparison with a helped/hurt/neutral/insufficient_data verdict), optionally for one change_id. Returns the rows plus the verdict methodology — this is CORRELATION, not causation, and insufficient_data is expected for low-traffic or recently-applied changes.',
    inputSchema: {
      type: 'object',
      properties: { change_id: { type: 'number', description: 'Optional — limit to one change from list_changes' } },
    },
    handler: async (env, a) => {
      const rows = (await analyticsImpact(env)) as { change_id: number }[];
      const filtered = a.change_id != null ? rows.filter((r) => r.change_id === Number(a.change_id)) : rows;
      return { rows: filtered, methodology: VERDICT_METHODOLOGY };
    },
  },
];

const rpcResult = (id: unknown, result: unknown): Response =>
  Response.json({ jsonrpc: '2.0', id, result });

const rpcError = (id: unknown, code: number, message: string, status = 200): Response =>
  Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // DNS-rebinding protection (spec MUST): browser-originated cross-site
  // requests carry an Origin header; API clients (Claude Code, curl) do not.
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return new Response('Forbidden', { status: 403 });
    } catch {
      return new Response('Forbidden', { status: 403 });
    }
  }

  if (request.method === 'GET' || request.method === 'DELETE') {
    // No server-initiated SSE streams and no sessions to delete.
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const versionHeader = request.headers.get('mcp-protocol-version');
  if (versionHeader && !SUPPORTED_VERSIONS.includes(versionHeader)) {
    return new Response('Bad Request: unsupported MCP-Protocol-Version', { status: 400 });
  }

  let message: any;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(message)) {
    return rpcError(null, -32600, 'Batching is not supported', 400);
  }

  // Notifications (no id) — including notifications/initialized — are accepted
  // with 202 and no body, per the transport spec.
  if (message.id === undefined || message.id === null) {
    return new Response(null, { status: 202 });
  }

  const { id, method, params } = message;
  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'seo-agent', version: VERSION },
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          const result = await tool.handler(env, params?.arguments ?? {}, ctx);
          return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (err) {
          // Tool-level failures are results with isError, not protocol errors.
          const text = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
          return rpcResult(id, { content: [{ type: 'text', text: `Error: ${text}` }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    console.error(JSON.stringify({ evt: 'mcp_error', method, error: err instanceof Error ? err.message : String(err) }));
    return rpcError(id, -32603, 'Internal error');
  }
}
