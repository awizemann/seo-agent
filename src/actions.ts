/**
 * The agent's operations, decoupled from transport: the REST routes
 * (index.ts) and the MCP tools (mcp.ts) both call these, so the two control
 * surfaces can never diverge. Failures throw ApiError; transports translate.
 */

import { runCrawl } from './crawl.js';
import { runRules } from './rules.js';
import { generateProposals, draftWithTrace } from './propose.js';
import { ingestGsc } from './gsc.js';
import { applyOverride, revertChange } from './overrides.js';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export async function runPipeline(env: Env) {
  const { runId, snapshots } = await runCrawl(env);
  const rules = await runRules(env, runId, snapshots);

  // Each stage is isolated: a failure in AI drafting (a hung/rate-limited model
  // call) or GSC must never discard the crawl+rules that already succeeded, and
  // must never take down the daily cron. Proposals commit one at a time, so a
  // mid-batch failure still persists everything drafted before it.
  let proposals;
  try {
    proposals = await generateProposals(env, runId);
  } catch (err) {
    console.error(JSON.stringify({ evt: 'proposals_error', error: err instanceof Error ? err.message : String(err) }));
    proposals = { created: 0, autoApplied: 0, error: err instanceof Error ? err.message : String(err) };
  }

  let gsc;
  try {
    gsc = await ingestGsc(env);
  } catch (err) {
    console.error(JSON.stringify({ evt: 'gsc_ingest_error', error: err instanceof Error ? err.message : String(err) }));
    gsc = { error: err instanceof Error ? err.message : String(err) };
  }
  return { runId, urls: snapshots.length, rules, proposals, gsc };
}

export async function statusData(env: Env) {
  const [lastRun, findings, proposals, changes, gscRows] = await Promise.all([
    env.DB.prepare('SELECT id, started_at, finished_at, url_count, ok FROM crawl_runs ORDER BY id DESC LIMIT 1').first(),
    env.DB.prepare("SELECT severity, COUNT(*) AS n FROM findings WHERE status = 'open' GROUP BY severity").all(),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM proposals GROUP BY status').all(),
    env.DB.prepare('SELECT COUNT(*) AS applied, SUM(CASE WHEN reverted_at IS NOT NULL THEN 1 ELSE 0 END) AS reverted FROM changes').first(),
    env.DB.prepare('SELECT COUNT(*) AS n, MAX(date) AS latest FROM gsc_daily').first(),
  ]);
  return {
    lastRun,
    openFindingsBySeverity: findings.results,
    proposalsByStatus: proposals.results,
    changes,
    gsc: gscRows,
    config: { autoApplyFields: env.AUTO_APPLY_FIELDS || '(none — approval required)', model: env.AI_MODEL },
  };
}

export async function listFindings(env: Env, status = 'open') {
  const rows = await env.DB.prepare(
    'SELECT id, created_at, path, rule, severity, detail, status FROM findings WHERE status = ? ORDER BY severity, path LIMIT 500'
  )
    .bind(status)
    .all();
  return rows.results;
}

export async function listProposals(env: Env, status = 'proposed') {
  const rows = await env.DB.prepare(
    'SELECT id, created_at, path, field, current_value, proposed_value, rationale, model, status FROM proposals WHERE status = ? ORDER BY id LIMIT 200'
  )
    .bind(status)
    .all();
  return rows.results;
}

export async function decideProposal(env: Env, id: number, action: 'approve' | 'reject') {
  const p = await env.DB.prepare("SELECT * FROM proposals WHERE id = ? AND status = 'proposed'").bind(id).first<{
    id: number;
    path: string;
    field: string;
    current_value: string | null;
    proposed_value: string;
  }>();
  if (!p) throw new ApiError('proposal not found or already decided', 404);
  const now = new Date().toISOString();
  if (action === 'reject') {
    await env.DB.prepare("UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ?").bind(now, id).run();
    return { ok: true, id, status: 'rejected' };
  }
  const changeId = await applyOverride(env, {
    path: p.path,
    field: p.field,
    value: p.proposed_value,
    oldValue: p.current_value,
    source: 'proposal',
    proposalId: p.id,
  });
  await env.DB.prepare("UPDATE proposals SET status = 'approved', decided_at = ?, applied_at = ? WHERE id = ?").bind(now, now, id).run();
  return { ok: true, id, status: 'approved', changeId, note: 'live within the KV cache TTL (~5 min)' };
}

export async function createProposal(
  env: Env,
  args: { path?: string; field?: string; value?: string; rationale?: string },
  validateDescription: (text: string) => string | null
) {
  const field = args.field || 'description';
  if (!args.path || !args.value) throw new ApiError('path and value required', 400);
  if (field !== 'description' && field !== 'title') throw new ApiError('field must be description or title', 400);
  if (field === 'description') {
    const reason = validateDescription(args.value);
    if (reason) throw new ApiError(`invalid description: ${reason}`, 400);
  }
  const snap = await env.DB.prepare('SELECT title, description FROM page_snapshots WHERE path = ? ORDER BY id DESC LIMIT 1')
    .bind(args.path)
    .first<{ title: string | null; description: string | null }>();
  const row = await env.DB.prepare(
    `INSERT INTO proposals (created_at, path, field, current_value, proposed_value, rationale, model)
     VALUES (?, ?, ?, ?, ?, ?, 'manual') RETURNING id`
  )
    .bind(
      new Date().toISOString(),
      args.path,
      field,
      (field === 'description' ? snap?.description : snap?.title) ?? null,
      args.value,
      args.rationale || 'manual'
    )
    .first<{ id: number }>();
  return { ok: true, id: row?.id, status: 'proposed' };
}

export async function dryRunDraft(env: Env, path: string | undefined) {
  if (!path) throw new ApiError('path required', 400);
  const snap = await env.DB.prepare('SELECT title, description FROM page_snapshots WHERE path = ? ORDER BY id DESC LIMIT 1')
    .bind(path)
    .first<{ title: string | null; description: string | null }>();
  if (!snap) throw new ApiError('no snapshot for that path — run a crawl first', 404);
  return draftWithTrace(env, { path, title: snap.title, current: snap.description });
}

export async function listChanges(env: Env) {
  const rows = await env.DB.prepare('SELECT * FROM changes ORDER BY id DESC LIMIT 200').all();
  return rows.results;
}

export async function revertById(env: Env, changeId: number) {
  const ok = await revertChange(env, changeId);
  if (!ok) throw new ApiError('change not found or already reverted', 404);
  return { ok: true };
}

export async function listOverrides(env: Env) {
  const list = await env.OVERRIDES.list({ prefix: 'override:' });
  return Promise.all(list.keys.map(async (k) => ({ key: k.name, value: await env.OVERRIDES.get(k.name) })));
}
