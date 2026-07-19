/**
 * The agent's operations, decoupled from transport: the REST routes
 * (index.ts) and the MCP tools (mcp.ts) both call these, so the two control
 * surfaces can never diverge. Failures throw ApiError; transports translate.
 */

import { runCrawl, prunePageSnapshots } from './crawl.js';
import { runRules, validateTitle, type Triggered } from './rules.js';
import { aeoChecks } from './aeo.js';
import { siteConfig } from './config.js';
import { enqueueCandidates, draftWithTrace } from './propose.js';
import { ingestGsc } from './gsc.js';
import { applyOverride, revertChange } from './overrides.js';
import { telemetrySummary, telemetryFindings, pruneTelemetry, listCrawlerHits as telemetryHits } from './telemetry.js';
import { runCitationProbes, citationFindings, citationConfig, alreadyCheckedToday } from './citations.js';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

// A run is "in progress" while its crawl_runs row has pipeline_done = 0 and is
// recent. The recency cutoff means a crashed run (which never marks itself done)
// stops blocking new runs after 15 minutes instead of wedging forever.
const IN_PROGRESS_WINDOW_MS = 15 * 60 * 1000;

export async function isRunning(env: Env): Promise<boolean> {
  const cutoff = new Date(Date.now() - IN_PROGRESS_WINDOW_MS).toISOString();
  const row = await env.DB.prepare(
    'SELECT id FROM crawl_runs WHERE pipeline_done = 0 AND started_at > ? ORDER BY id DESC LIMIT 1'
  )
    .bind(cutoff)
    .first();
  return !!row;
}

/**
 * Atomically claim a run: insert a crawl_runs row ONLY when no un-finished
 * recent run exists, in a single statement so two near-simultaneous starts can't
 * both win (a check-then-act race would). Returns the new run id, or null when
 * another run already holds the slot. The inserted row is what runCrawl fills in.
 */
export async function claimRun(env: Env): Promise<number | null> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - IN_PROGRESS_WINDOW_MS).toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO crawl_runs (started_at, pipeline_done)
     SELECT ?1, 0
     WHERE NOT EXISTS (SELECT 1 FROM crawl_runs WHERE pipeline_done = 0 AND started_at > ?2)`
  )
    .bind(now, cutoff)
    .run();
  if ((res.meta?.changes ?? 0) < 1) return null; // another start won the race
  return res.meta.last_row_id;
}

/**
 * Start the pipeline in the background and return immediately. The caller's
 * `waitUntil` keeps the Worker alive until the run finishes; the dashboard/MCP
 * poll statusData() for `running=false` + a new lastRun. Refuses to start a
 * second concurrent run (atomically, via claimRun — the button double-click /
 * cron overlap guard).
 */
export async function startRun(env: Env, waitUntil: (p: Promise<unknown>) => void): Promise<{ started: boolean; running: boolean }> {
  const runId = await claimRun(env);
  if (runId === null) return { started: false, running: true };
  waitUntil(
    runPipeline(env, runId)
      .then((r) => console.log(JSON.stringify({ evt: 'run_complete', ...r })))
      .catch((err) => console.error(JSON.stringify({ evt: 'run_error', error: err instanceof Error ? err.message : String(err) })))
  );
  return { started: true, running: true };
}

export async function runPipeline(env: Env, runId: number) {
  const { snapshots } = await runCrawl(env, runId);
  try {
    // Sense modules share the findings lifecycle but are isolated — a failure
    // in any of them degrades to zero findings from that sense, never a
    // failed run.
    const extra: Triggered[] = [];
    const sense = async (name: string, fn: () => Promise<Triggered[]>) => {
      try {
        extra.push(...(await fn()));
      } catch (err) {
        console.error(JSON.stringify({ evt: `${name}_error`, error: err instanceof Error ? err.message : String(err) }));
      }
    };
    await sense('aeo', () => aeoChecks(env, snapshots));
    await sense('telemetry', () => telemetryFindings(env));

    // Weekly citation probes ride the daily pipeline: on the configured UTC
    // weekday, probe once (idempotent per day, so a manual /run can't
    // double-spend API calls). Isolated like the senses above.
    //
    // Ordering matters: on a probe day we sense citations AFTER the probe, once.
    // Sensing before would evaluate stale rows — a still-open citation_lost from
    // last week could open in the SAME run as the fresh citation_gained the probe
    // produces (contradictory findings for the same query).
    let citations;
    let citationsSensed = false;
    try {
      const { queries, engines, cronDay } = citationConfig(env);
      if (queries.length > 0 && engines.length > 0 && new Date().getUTCDay() === cronDay && !(await alreadyCheckedToday(env))) {
        citations = await runCitationProbes(env);
        await sense('citations', () => citationFindings(env));
        citationsSensed = true;
      }
    } catch (err) {
      console.error(JSON.stringify({ evt: 'citation_probe_error', error: err instanceof Error ? err.message : String(err) }));
    }
    // Non-probe runs (and probe attempts that threw before sensing) fold the
    // current citation state in exactly once.
    if (!citationsSensed) await sense('citations', () => citationFindings(env));

    try {
      await pruneTelemetry(env);
    } catch {
      // retention pruning is best-effort
    }
    try {
      await prunePageSnapshots(env);
    } catch {
      // retention pruning is best-effort
    }

    const rules = await runRules(env, runId, snapshots, dedupeTriggered(extra));

    // Drafting is off the critical path: enqueue one job per candidate and let
    // the queue consumer draft them one at a time. A failure here (or in a
    // single draft later) can't discard the crawl+rules or stall the run.
    let proposals;
    try {
      proposals = await enqueueCandidates(env, runId);
    } catch (err) {
      console.error(JSON.stringify({ evt: 'enqueue_error', error: err instanceof Error ? err.message : String(err) }));
      proposals = { enqueued: 0, error: err instanceof Error ? err.message : String(err) };
    }

    let gsc;
    try {
      gsc = await ingestGsc(env);
    } catch (err) {
      console.error(JSON.stringify({ evt: 'gsc_ingest_error', error: err instanceof Error ? err.message : String(err) }));
      gsc = { error: err instanceof Error ? err.message : String(err) };
    }
    return { runId, urls: snapshots.length, rules, proposals, gsc, citations };
  } finally {
    // Mark the run finished whether the post-crawl stages succeeded or not, so
    // it stops reading as "in progress" the moment real work is done.
    await env.DB.prepare('UPDATE crawl_runs SET pipeline_done = 1 WHERE id = ?').bind(runId).run();
  }
}

// A path can be flagged by more than one sense in a run (e.g. an AEO check and
// a telemetry rule) — the findings upsert dedupes by (path, rule) key anyway,
// but keep the triggered list clean for the log line.
function dedupeTriggered(list: Triggered[]): Triggered[] {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = `${t.path} ${t.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function statusData(env: Env) {
  // aeo_hits / citations were added in a later version; on a database upgraded
  // WITHOUT re-running db:init those tables don't exist and the sub-queries
  // throw. Degrade each to an inactive/empty block so /status still returns 200
  // (re-run `npm run db:init` — idempotent — to create them).
  const emptyTelemetry = { active: false, lastHit: null, crawler7d: [] as { bot: string; n: number }[], referral7d: 0, md7d: 0 };
  const [lastRun, findings, proposals, changes, gscRows, running, telemetry, latestCitations] = await Promise.all([
    env.DB.prepare('SELECT id, started_at, finished_at, url_count, ok, pipeline_done FROM crawl_runs ORDER BY id DESC LIMIT 1').first(),
    env.DB.prepare("SELECT severity, COUNT(*) AS n FROM findings WHERE status = 'open' GROUP BY severity").all(),
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM proposals GROUP BY status').all(),
    env.DB.prepare('SELECT COUNT(*) AS applied, SUM(CASE WHEN reverted_at IS NOT NULL THEN 1 ELSE 0 END) AS reverted FROM changes').first(),
    env.DB.prepare('SELECT COUNT(*) AS n, MAX(date) AS latest FROM gsc_daily').first(),
    isRunning(env),
    telemetrySummary(env).catch(() => emptyTelemetry),
    env.DB.prepare(
      'SELECT MAX(checked_at) AS last, COUNT(*) AS total, SUM(cited) AS cited FROM citations WHERE checked_at = (SELECT MAX(checked_at) FROM citations)'
    )
      .first<{ last: string | null; total: number; cited: number | null }>()
      .catch(() => null),
  ]);
  const citCfg = citationConfig(env);
  return {
    lastRun,
    running,
    openFindingsBySeverity: findings.results,
    proposalsByStatus: proposals.results,
    changes,
    gsc: gscRows,
    aeo: {
      telemetry,
      citations: {
        lastCheck: latestCitations?.last ?? null,
        cited: latestCitations?.cited ?? 0,
        total: latestCitations?.total ?? 0,
        queries: citCfg.queries.length,
        engines: citCfg.engines,
      },
    },
    config: {
      autoApplyFields: env.AUTO_APPLY_FIELDS || '(none — approval required)',
      model: env.AI_MODEL,
      aeoChecks: siteConfig(env).aeoChecks,
    },
  };
}

export async function listAeoHits(env: Env, days = 7, limit = 200) {
  return telemetryHits(env, days, limit);
}

export async function listCitations(env: Env, limit = 200) {
  const rows = await env.DB.prepare(
    'SELECT checked_at, engine, query, cited, rank, cited_url, total_sources, error FROM citations ORDER BY id DESC LIMIT ?'
  )
    .bind(Math.min(Math.max(limit, 1), 500))
    .all();
  return rows.results;
}

export async function runCitationCheck(env: Env) {
  return runCitationProbes(env);
}

export async function listFindings(env: Env, status = 'open') {
  const rows = await env.DB.prepare(
    `SELECT id, created_at, path, rule, severity, detail, status FROM findings WHERE status = ?
     ORDER BY CASE severity
       WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5
     END, path
     LIMIT 500`
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
  } else {
    // Title proposals previously bypassed all validation.
    const reason = validateTitle(args.value);
    if (reason) throw new ApiError(`invalid title: ${reason}`, 400);
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
  const result = await revertChange(env, changeId);
  if (!result.ok) throw new ApiError(result.error, result.status);
  return { ok: true };
}

export async function listOverrides(env: Env) {
  const list = await env.OVERRIDES.list({ prefix: 'override:' });
  return Promise.all(list.keys.map(async (k) => ({ key: k.name, value: await env.OVERRIDES.get(k.name) })));
}
