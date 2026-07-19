/**
 * The agent's operations, decoupled from transport: the REST routes
 * (index.ts) and the MCP tools (mcp.ts) both call these, so the two control
 * surfaces can never diverge. Failures throw ApiError; transports translate.
 */

import { runCrawl, prunePageSnapshots } from './crawl.js';
import { runRules, validateTitle, type Triggered } from './rules.js';
import { aeoChecks } from './aeo.js';
import { siteConfig } from './config.js';
import { enqueueCandidates, draftWithTrace, PROPOSABLE_RULES } from './propose.js';
import { ingestGsc } from './gsc.js';
import { applyOverride, revertChange } from './overrides.js';
import { telemetrySummary, telemetryFindings, pruneTelemetry, rollupTelemetryWeekly, listCrawlerHits as telemetryHits } from './telemetry.js';
import { runCitationProbes, citationFindings, citationConfig, alreadyCheckedToday } from './citations.js';
import { impactFindings } from './impact.js';

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
    // Change-impact sense: computes any newly-computable d14/d28 verdicts from
    // GSC history (uses the previous run's ingest — GSC lags days regardless)
    // and surfaces hurt/helped changes. No-ops on GSC-off instances.
    await sense('impact', () => impactFindings(env));

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
      // Write-once weekly rollups BEFORE the prune: a completed week is frozen
      // on the first run after it closes, long before the prune could touch it
      // (see rollupTelemetryWeekly for the eligibility guard).
      await rollupTelemetryWeekly(env);
    } catch {
      // weekly rollup is best-effort
    }
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

// A finding's remediation state — where the fix stands — derived from its LATEST
// linked proposal (proposals.finding_id). `null` when there is no live work.
export type RemediationState = 'proposal_pending' | 'applied_awaiting_recrawl' | 'proposal_rejected';
export type Remediation = { state: RemediationState; proposalId: number } | null;

/**
 * Map a finding's latest proposal (by id) to its remediation state. Pure and
 * unit-tested. Proposal status is authoritative on its own: revertChange flips a
 * reverted proposal off 'approved' to 'reverted', so an 'approved' proposal
 * always has a live (un-reverted) change — no changes-table join needed.
 *   proposed  → proposal_pending          (a draft is awaiting a human decision)
 *   approved  → applied_awaiting_recrawl  (fix is live; the finding clears next crawl)
 *   rejected  → proposal_rejected
 *   reverted / none → null                (no active remediation)
 */
export function remediationFor(p: { id: number; status: string } | undefined | null): Remediation {
  if (!p) return null;
  if (p.status === 'proposed') return { state: 'proposal_pending', proposalId: p.id };
  if (p.status === 'approved') return { state: 'applied_awaiting_recrawl', proposalId: p.id };
  if (p.status === 'rejected') return { state: 'proposal_rejected', proposalId: p.id };
  return null;
}

export async function listFindings(env: Env, status = 'open') {
  const rows = (
    await env.DB.prepare(
      `SELECT id, created_at, path, rule, severity, detail, status FROM findings WHERE status = ?
       ORDER BY CASE severity
         WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5
       END, path
       LIMIT 500`
    )
      .bind(status)
      .all<{ id: number; created_at: string; path: string; rule: string; severity: string; detail: string | null; status: string }>()
  ).results;
  if (rows.length === 0) return rows;

  // Remediation: each finding's latest proposal by finding_id. The proposals
  // table is small (drafted candidates only), so the latest-per-finding read is
  // global and param-free rather than an IN-list over the (up to 500) findings.
  const latestByFinding = new Map<number, { id: number; status: string }>();
  const propRows = (
    await env.DB.prepare(
      `SELECT finding_id, id, status FROM proposals
       WHERE finding_id IS NOT NULL AND id IN (
         SELECT MAX(id) FROM proposals WHERE finding_id IS NOT NULL GROUP BY finding_id
       )`
    ).all<{ finding_id: number; id: number; status: string }>()
  ).results;
  for (const p of propRows) latestByFinding.set(p.finding_id, { id: p.id, status: p.status });

  // Draftable: an OPEN finding on a description-fixable rule whose page has no
  // live (proposed/approved) description proposal — the SAME idempotency the
  // queue consumer enforces, so the "Draft fix" button can never fire a no-op.
  const livePaths = new Set<string>();
  if (status === 'open') {
    const live = (
      await env.DB.prepare("SELECT DISTINCT path FROM proposals WHERE field = 'description' AND status IN ('proposed', 'approved')").all<{
        path: string;
      }>()
    ).results;
    for (const r of live) livePaths.add(r.path);
  }

  return rows.map((f) => ({
    ...f,
    remediation: remediationFor(latestByFinding.get(f.id)),
    draftable: status === 'open' && PROPOSABLE_RULES.has(f.rule) && !livePaths.has(f.path),
  }));
}

/**
 * Pure state-transition guard for dismiss/restore, so the 404/409 contract is
 * pinned without a DB. Returns the error to throw, or null when the move is legal.
 */
export function findingTransitionError(
  current: { status: string } | null | undefined,
  want: 'dismiss' | 'restore'
): { status: number; message: string } | null {
  if (!current) return { status: 404, message: 'finding not found' };
  const need = want === 'dismiss' ? 'open' : 'dismissed';
  if (current.status !== need) {
    const verb = want === 'dismiss' ? 'dismissed' : 'restored';
    return { status: 409, message: `finding is ${current.status}, only ${need} findings can be ${verb}` };
  }
  return null;
}

/**
 * Dismiss (mute) an OPEN finding. Sets status='dismissed' and stamps resolved_at
 * (the generic closed-at) so it drops out of the open list and the open-findings
 * series at dismissal time. Unlike auto-resolve, the mute holds: runRules skips
 * re-opening a dismissed (path, rule) until it is restored.
 */
export async function dismissFinding(env: Env, id: number) {
  const f = await env.DB.prepare('SELECT id, status FROM findings WHERE id = ?').bind(id).first<{ id: number; status: string }>();
  const err = findingTransitionError(f, 'dismiss');
  if (err) throw new ApiError(err.message, err.status);
  const now = new Date().toISOString();
  // The status guard in the UPDATE makes a double-click / race a no-op, not a
  // second stamp.
  await env.DB.prepare("UPDATE findings SET status = 'dismissed', resolved_at = ? WHERE id = ? AND status = 'open'").bind(now, id).run();
  console.log(JSON.stringify({ evt: 'finding_dismissed', id }));
  return { ok: true, id, status: 'dismissed' };
}

/**
 * Restore a DISMISSED finding: flip it to 'resolved' (lifting the mute). It does
 * NOT re-open here — the next crawl re-opens it naturally if the condition still
 * holds, which keeps "open" meaning "currently triggering".
 */
export async function restoreFinding(env: Env, id: number) {
  const f = await env.DB.prepare('SELECT id, status FROM findings WHERE id = ?').bind(id).first<{ id: number; status: string }>();
  const err = findingTransitionError(f, 'restore');
  if (err) throw new ApiError(err.message, err.status);
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE findings SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'dismissed'").bind(now, id).run();
  console.log(JSON.stringify({ evt: 'finding_restored', id }));
  return { ok: true, id, status: 'resolved', note: 're-opens on the next crawl if the condition still holds' };
}

/**
 * "Draft fix": enqueue an AI meta-description draft for an OPEN, description-
 * fixable finding by sending the exact job the pipeline's candidate selection
 * would — the queue consumer (draftAndCreate) creates the proposal. Reuses the
 * consumer's path-level idempotency, so this is a no-op when a live proposal
 * already exists.
 */
export async function draftFinding(env: Env, id: number) {
  const f = await env.DB.prepare('SELECT id, path, rule, status FROM findings WHERE id = ?')
    .bind(id)
    .first<{ id: number; path: string; rule: string; status: string }>();
  if (!f) throw new ApiError('finding not found', 404);
  if (f.status !== 'open') throw new ApiError(`finding is ${f.status}, only open findings can be drafted`, 409);
  if (!PROPOSABLE_RULES.has(f.rule)) throw new ApiError(`rule ${f.rule} is not one the drafting pipeline can fix`, 400);
  const existing = await env.DB.prepare(
    "SELECT 1 FROM proposals WHERE path = ? AND field = 'description' AND status IN ('proposed', 'approved') LIMIT 1"
  )
    .bind(f.path)
    .first();
  if (existing) return { ok: true, enqueued: 0, note: 'a proposal for this page is already live' };
  const snap = await env.DB.prepare('SELECT title, description FROM page_snapshots WHERE path = ? ORDER BY id DESC LIMIT 1')
    .bind(f.path)
    .first<{ title: string | null; description: string | null }>();
  if (!snap) throw new ApiError('no snapshot for that path — run a crawl first', 404);
  await env.DRAFT_QUEUE.send({ findingId: f.id, path: f.path, rule: f.rule, title: snap.title, current: snap.description });
  console.log(JSON.stringify({ evt: 'finding_draft_enqueued', id, path: f.path }));
  return { ok: true, enqueued: 1, note: 'draft queued — the proposal appears within ~1–2 min' };
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
