/**
 * The agent's operations, decoupled from transport: the REST routes
 * (index.ts) and the MCP tools (mcp.ts) both call these, so the two control
 * surfaces can never diverge. Failures throw ApiError; transports translate.
 */

import { runCrawl, prunePageSnapshots } from './crawl.js';
import { runRules, validateTitle, type Triggered } from './rules.js';
import { aeoChecks } from './aeo.js';
import { enqueueCandidates, draftWithTrace, invalidReason, fieldForRule } from './propose.js';
import { findBannedTerm, type SiteConfig } from './config.js';
import { ingestGsc } from './gsc.js';
import { applyOverride, applyResource, revertChange, isPatternSpec, mdTwinPathReason, RESOURCE_FIELDS, RESOURCE_MAX_CHARS } from './overrides.js';
import { telemetrySummary, telemetryFindings, pruneTelemetry, rollupTelemetryWeekly, listCrawlerHits as telemetryHits } from './telemetry.js';
import { runCitationProbes, citationFindings, citationConfig, alreadyCheckedToday } from './citations.js';
import { impactFindings } from './impact.js';
import { overrideVerificationFindings } from './verify.js';
import type { AgentDeps } from './deps.js';

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

export async function isRunning(deps: Pick<AgentDeps, 'db'>): Promise<boolean> {
  const cutoff = new Date(Date.now() - IN_PROGRESS_WINDOW_MS).toISOString();
  const row = await deps.db.prepare(
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
export async function claimRun(deps: Pick<AgentDeps, 'db'>): Promise<number | null> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - IN_PROGRESS_WINDOW_MS).toISOString();
  const res = await deps.db.prepare(
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
export async function startRun(deps: AgentDeps, waitUntil: (p: Promise<unknown>) => void): Promise<{ started: boolean; running: boolean }> {
  const runId = await claimRun(deps);
  if (runId === null) return { started: false, running: true };
  waitUntil(
    runPipeline(deps, runId)
      .then((r) => console.log(JSON.stringify({ evt: 'run_complete', ...r })))
      .catch((err) => console.error(JSON.stringify({ evt: 'run_error', error: err instanceof Error ? err.message : String(err) })))
  );
  return { started: true, running: true };
}

export async function runPipeline(deps: AgentDeps, runId: number) {
  const { snapshots } = await runCrawl(deps, runId);
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
    await sense('aeo', () => aeoChecks(deps.config, snapshots));
    // Override-verification sense: config-free proof that the edge SEO layer is
    // still serving what we approved (KV expected vs crawled delivered). It
    // lands before the shellTitle detector in rules.ts contributes its own
    // injection_regression for the same path — both share the (path, rule) key
    // and runRules keeps the FIRST occurrence, so this more specific detail wins.
    await sense('override_verify', () => overrideVerificationFindings(deps, snapshots));
    await sense('telemetry', () => telemetryFindings(deps.db));
    // Change-impact sense: computes any newly-computable d14/d28 verdicts from
    // GSC history (uses the previous run's ingest — GSC lags days regardless)
    // and surfaces hurt/helped changes. No-ops on GSC-off instances.
    await sense('impact', () => impactFindings(deps));

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
      const { queries, engines, cronDay } = citationConfig(deps);
      if (queries.length > 0 && engines.length > 0 && new Date().getUTCDay() === cronDay && !(await alreadyCheckedToday(deps))) {
        citations = await runCitationProbes(deps);
        await sense('citations', () => citationFindings(deps));
        citationsSensed = true;
      }
    } catch (err) {
      console.error(JSON.stringify({ evt: 'citation_probe_error', error: err instanceof Error ? err.message : String(err) }));
    }
    // Non-probe runs (and probe attempts that threw before sensing) fold the
    // current citation state in exactly once.
    if (!citationsSensed) await sense('citations', () => citationFindings(deps));

    try {
      // Write-once weekly rollups BEFORE the prune: a completed week is frozen
      // on the first run after it closes, long before the prune could touch it
      // (see rollupTelemetryWeekly for the eligibility guard).
      await rollupTelemetryWeekly(deps.db);
    } catch {
      // weekly rollup is best-effort
    }
    try {
      await pruneTelemetry(deps.db);
    } catch {
      // retention pruning is best-effort
    }
    try {
      await prunePageSnapshots(deps);
    } catch {
      // retention pruning is best-effort
    }

    const rules = await runRules(deps, runId, snapshots, dedupeTriggered(extra));

    // Drafting is off the critical path: enqueue one job per candidate and let
    // the queue consumer draft them one at a time. A failure here (or in a
    // single draft later) can't discard the crawl+rules or stall the run.
    let proposals;
    try {
      proposals = await enqueueCandidates(deps, runId);
    } catch (err) {
      console.error(JSON.stringify({ evt: 'enqueue_error', error: err instanceof Error ? err.message : String(err) }));
      proposals = { enqueued: 0, error: err instanceof Error ? err.message : String(err) };
    }

    let gsc;
    try {
      gsc = await ingestGsc(deps);
    } catch (err) {
      console.error(JSON.stringify({ evt: 'gsc_ingest_error', error: err instanceof Error ? err.message : String(err) }));
      gsc = { error: err instanceof Error ? err.message : String(err) };
    }
    return { runId, urls: snapshots.length, rules, proposals, gsc, citations };
  } finally {
    // Mark the run finished whether the post-crawl stages succeeded or not, so
    // it stops reading as "in progress" the moment real work is done.
    await deps.db.prepare('UPDATE crawl_runs SET pipeline_done = 1 WHERE id = ?').bind(runId).run();
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

export async function statusData(deps: Pick<AgentDeps, 'db' | 'config' | 'secrets'>) {
  // aeo_hits / citations were added in a later version; on a database upgraded
  // WITHOUT re-running db:init those tables don't exist and the sub-queries
  // throw. Degrade each to an inactive/empty block so /status still returns 200
  // (re-run `npm run db:init` — idempotent — to create them).
  const emptyTelemetry = { active: false, lastHit: null, crawler7d: [] as { bot: string; n: number }[], referral7d: 0, search7d: 0, md7d: 0 };
  const [lastRun, findings, proposals, changes, gscRows, running, telemetry, latestCitations] = await Promise.all([
    deps.db.prepare('SELECT id, started_at, finished_at, url_count, ok, pipeline_done FROM crawl_runs ORDER BY id DESC LIMIT 1').first(),
    deps.db.prepare("SELECT severity, COUNT(*) AS n FROM findings WHERE status = 'open' GROUP BY severity").all(),
    deps.db.prepare('SELECT status, COUNT(*) AS n FROM proposals GROUP BY status').all(),
    deps.db.prepare('SELECT COUNT(*) AS applied, SUM(CASE WHEN reverted_at IS NOT NULL THEN 1 ELSE 0 END) AS reverted FROM changes').first(),
    deps.db.prepare('SELECT COUNT(*) AS n, MAX(date) AS latest FROM gsc_daily').first(),
    isRunning(deps),
    telemetrySummary(deps.db).catch(() => emptyTelemetry),
    deps.db.prepare(
      'SELECT MAX(checked_at) AS last, COUNT(*) AS total, SUM(cited) AS cited FROM citations WHERE checked_at = (SELECT MAX(checked_at) FROM citations)'
    )
      .first<{ last: string | null; total: number; cited: number | null }>()
      .catch(() => null),
  ]);
  const citCfg = citationConfig(deps);
  const cfg = deps.config;
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
      autoApplyFields: cfg.autoApplyFields.join(',') || '(none — approval required)',
      model: cfg.aiModel,
      aeoChecks: cfg.aeoChecks,
    },
  };
}

export async function listAeoHits(deps: Pick<AgentDeps, 'db'>, days = 7, limit = 200) {
  return telemetryHits(deps.db, days, limit);
}

export async function listCitations(deps: Pick<AgentDeps, 'db'>, limit = 200) {
  const rows = await deps.db.prepare(
    'SELECT checked_at, engine, query, cited, rank, cited_url, total_sources, error FROM citations ORDER BY id DESC LIMIT ?'
  )
    .bind(Math.min(Math.max(limit, 1), 500))
    .all();
  return rows.results;
}

export async function runCitationCheck(deps: Pick<AgentDeps, 'db' | 'config' | 'secrets'>) {
  return runCitationProbes(deps);
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

export async function listFindings(deps: Pick<AgentDeps, 'db'>, status = 'open') {
  const rows = (
    await deps.db.prepare(
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
    await deps.db.prepare(
      `SELECT finding_id, id, status FROM proposals
       WHERE finding_id IS NOT NULL AND id IN (
         SELECT MAX(id) FROM proposals WHERE finding_id IS NOT NULL GROUP BY finding_id
       )`
    ).all<{ finding_id: number; id: number; status: string }>()
  ).results;
  for (const p of propRows) latestByFinding.set(p.finding_id, { id: p.id, status: p.status });

  // Draftable: an OPEN finding on a draftable rule whose page has no live
  // (proposed/approved) proposal FOR THAT RULE'S FIELD — the SAME idempotency
  // the queue consumer enforces, so the "Draft fix" button can never fire a
  // no-op. Keyed per (path, field): a live title proposal must not grey out the
  // description draft on the same page, or vice versa.
  const liveKeys = new Set<string>();
  if (status === 'open') {
    const live = (
      await deps.db.prepare(
        "SELECT DISTINCT path, field FROM proposals WHERE field IN ('description', 'title') AND status IN ('proposed', 'approved')"
      ).all<{ path: string; field: string }>()
    ).results;
    for (const r of live) liveKeys.add(liveKey(r.path, r.field));
  }

  return rows.map((f) => {
    const field = fieldForRule(f.rule);
    return {
      ...f,
      remediation: remediationFor(latestByFinding.get(f.id)),
      draftable: status === 'open' && !!field && !liveKeys.has(liveKey(f.path, field)),
    };
  });
}

// A page path may contain any character a URL path may, so the (path, field)
// composite key is joined on NUL — which one never can.
const liveKey = (path: string, field: string): string => `${path}\u0000${field}`;

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
export async function dismissFinding(deps: Pick<AgentDeps, 'db'>, id: number) {
  const f = await deps.db.prepare('SELECT id, status FROM findings WHERE id = ?').bind(id).first<{ id: number; status: string }>();
  const err = findingTransitionError(f, 'dismiss');
  if (err) throw new ApiError(err.message, err.status);
  const now = new Date().toISOString();
  // The status guard in the UPDATE makes a double-click / race a no-op, not a
  // second stamp.
  await deps.db.prepare("UPDATE findings SET status = 'dismissed', resolved_at = ? WHERE id = ? AND status = 'open'").bind(now, id).run();
  console.log(JSON.stringify({ evt: 'finding_dismissed', id }));
  return { ok: true, id, status: 'dismissed' };
}

/**
 * Restore a DISMISSED finding: flip it to 'resolved' (lifting the mute). It does
 * NOT re-open here — the next crawl re-opens it naturally if the condition still
 * holds, which keeps "open" meaning "currently triggering".
 */
export async function restoreFinding(deps: Pick<AgentDeps, 'db'>, id: number) {
  const f = await deps.db.prepare('SELECT id, status FROM findings WHERE id = ?').bind(id).first<{ id: number; status: string }>();
  const err = findingTransitionError(f, 'restore');
  if (err) throw new ApiError(err.message, err.status);
  const now = new Date().toISOString();
  await deps.db.prepare("UPDATE findings SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'dismissed'").bind(now, id).run();
  console.log(JSON.stringify({ evt: 'finding_restored', id }));
  return { ok: true, id, status: 'resolved', note: 're-opens on the next crawl if the condition still holds' };
}

/**
 * "Draft fix": enqueue a draft for an OPEN, fixable finding by sending the exact
 * job the pipeline's candidate selection would — the queue consumer
 * (draftAndCreate) creates the proposal. Reuses the consumer's (path, field)
 * idempotency, so this is a no-op when a live proposal for the same field
 * already exists — and stays available when the page's OTHER field has one.
 */
export async function draftFinding(deps: Pick<AgentDeps, 'db' | 'draftQueue'>, id: number) {
  const f = await deps.db.prepare('SELECT id, path, rule, detail, status FROM findings WHERE id = ?')
    .bind(id)
    .first<{ id: number; path: string; rule: string; detail: string | null; status: string }>();
  if (!f) throw new ApiError('finding not found', 404);
  if (f.status !== 'open') throw new ApiError(`finding is ${f.status}, only open findings can be drafted`, 409);
  const field = fieldForRule(f.rule);
  if (!field) throw new ApiError(`rule ${f.rule} is not one the drafting pipeline can fix`, 400);
  const existing = await deps.db.prepare(
    "SELECT 1 FROM proposals WHERE path = ? AND field = ? AND status IN ('proposed', 'approved') LIMIT 1"
  )
    .bind(f.path, field)
    .first();
  if (existing) return { ok: true, enqueued: 0, note: `a ${field} proposal for this page is already live` };
  const snap = await deps.db.prepare('SELECT title, description FROM page_snapshots WHERE path = ? ORDER BY id DESC LIMIT 1')
    .bind(f.path)
    .first<{ title: string | null; description: string | null }>();
  if (!snap) throw new ApiError('no snapshot for that path — run a crawl first', 404);
  await deps.draftQueue.send({
    findingId: f.id,
    path: f.path,
    rule: f.rule,
    field,
    detail: f.detail,
    title: snap.title,
    description: snap.description,
    current: field === 'title' ? snap.title : snap.description,
  });
  console.log(JSON.stringify({ evt: 'finding_draft_enqueued', id, path: f.path }));
  return { ok: true, enqueued: 1, note: 'draft queued — the proposal appears within ~1–2 min' };
}

export async function listProposals(deps: Pick<AgentDeps, 'db'>, status = 'proposed') {
  const rows = await deps.db.prepare(
    'SELECT id, created_at, path, field, current_value, proposed_value, rationale, model, status FROM proposals WHERE status = ? ORDER BY id LIMIT 200'
  )
    .bind(status)
    .all();
  return rows.results;
}

/**
 * Why an already-drafted proposal must not be applied NOW, or null.
 *
 * A draft is written once and approved later — possibly after the site's
 * vocabulary changed. Generation-time validation cannot see that future, so
 * approval re-checks the value against the CURRENT config: otherwise banning a
 * term leaves every draft that already contains it approvable, and the ban is a
 * promise the system quietly breaks.
 *
 * Scoped to the banned-term rule on purpose. With no banned terms configured
 * this is a no-op (the historical behavior), so approval can never start
 * failing on a shape rule — length, sentence form — that was already enforced
 * when the draft was created.
 *
 * `description` runs the full validator (it is the field invalidReason is
 * written for); every other field — `title` and the whole-file resource fields
 * — gets the deterministic term match on its text. A resource body is a whole
 * file rather than a sentence, but a banned name inside it is published to the
 * open web just the same, so the check is worth its one regex pass.
 */
export function approvalBlockedReason(
  p: { field: string; proposed_value: string },
  config?: Pick<SiteConfig, 'bannedTerms'>
): string | null {
  if (!config?.bannedTerms?.length) return null;
  const detail =
    p.field === 'description'
      ? invalidReason(p.proposed_value, config)
      : (() => {
          const banned = findBannedTerm(p.proposed_value, config.bannedTerms);
          return banned ? `contains banned term "${banned}"` : null;
        })();
  if (!detail) return null;
  return `this draft is no longer valid under the site's current vocabulary: ${detail}. Reject it and draft again.`;
}

export async function decideProposal(
  deps: Pick<AgentDeps, 'db' | 'overrides'> & Partial<Pick<AgentDeps, 'config'>>,
  id: number,
  action: 'approve' | 'reject'
) {
  const p = await deps.db.prepare("SELECT * FROM proposals WHERE id = ? AND status = 'proposed'").bind(id).first<{
    id: number;
    path: string;
    field: string;
    current_value: string | null;
    proposed_value: string;
  }>();
  if (!p) throw new ApiError('proposal not found or already decided', 404);
  const now = new Date().toISOString();
  if (action === 'reject') {
    await deps.db.prepare("UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ?").bind(now, id).run();
    return { ok: true, id, status: 'rejected' };
  }
  // Re-validate against the CURRENT config before anything is published: the
  // draft may predate a vocabulary change (see approvalBlockedReason).
  const stale = approvalBlockedReason(p, deps.config);
  if (stale) throw new ApiError(stale, 409);
  // Resource fields (llms_txt, llms_full_txt, robots_txt, md_twin) publish a whole file
  // to its own KV key; page fields merge into the path's override object. Same
  // journal either way, so approve/revert read identically from the outside.
  const changeId = RESOURCE_FIELDS.has(p.field)
    ? await applyResource(deps, {
        field: p.field,
        value: p.proposed_value,
        // Only a PATTERN field reads this (md_twin derives its key from the
        // page path); a fixed field ignores it and uses its pinned path.
        path: p.path,
        // No oldValue: a resource's prior state is whatever WE published (see
        // applyResource) — the proposal's origin snapshot is not ours to restore.
        source: 'proposal',
        proposalId: p.id,
      })
    : await applyOverride(deps, {
        path: p.path,
        field: p.field,
        value: p.proposed_value,
        oldValue: p.current_value,
        source: 'proposal',
        proposalId: p.id,
      });
  await deps.db.prepare("UPDATE proposals SET status = 'approved', decided_at = ?, applied_at = ? WHERE id = ?").bind(now, now, id).run();
  return { ok: true, id, status: 'approved', changeId, note: 'live within the KV cache TTL (~5 min)' };
}

export async function createProposal(
  deps: Pick<AgentDeps, 'db'> & Partial<Pick<AgentDeps, 'config'>>,
  args: { path?: string; field?: string; value?: string; rationale?: string; currentValue?: string | null },
  validateDescription: (text: string) => string | null
) {
  const field = args.field || 'description';
  if (!args.path || !args.value) throw new ApiError('path and value required', 400);
  const resource = RESOURCE_FIELDS.get(field);
  if (field !== 'description' && field !== 'title' && !resource) {
    throw new ApiError(`field must be description, title, or one of: ${[...RESOURCE_FIELDS.keys()].join(', ')}`, 400);
  }
  if (resource) {
    // A resource body is a whole file, not a meta string: the only checks that
    // generalize are "not blank" and a sanity bound. A FIXED field's path is
    // pinned by the field, so a mismatched one is a caller bug, not a second
    // resource. A PATTERN field's path is the PAGE the twin belongs to, so the
    // check is that it is a clean page path — the key is still derived, never
    // supplied.
    if (isPatternSpec(resource)) {
      const reason = mdTwinPathReason(args.path);
      if (reason) throw new ApiError(`invalid path for ${field}: ${reason}`, 400);
    } else if (args.path !== resource.path) {
      throw new ApiError(`field ${field} is always published at ${resource.path}`, 400);
    }
    if (!args.value.trim()) throw new ApiError(`invalid ${field}: empty after trimming`, 400);
    if (args.value.length > RESOURCE_MAX_CHARS) {
      throw new ApiError(`invalid ${field}: too long (${args.value.length} chars, max ${RESOURCE_MAX_CHARS})`, 400);
    }
    // One open proposal per file. A resource proposal is the WHOLE file, so two
    // of them are two rival versions of the same bytes: approving both applies
    // the older one's body second (last write wins) and the reviewer has no way
    // to see that from either diff. Page fields don't need this — they're a
    // single meta string, and the newest approval is unambiguously the answer.
    // A pattern field has one file PER PAGE, so its uniqueness is per (field,
    // path); a fixed field's single file makes the path redundant either way.
    const open = isPatternSpec(resource)
      ? await deps.db.prepare("SELECT id FROM proposals WHERE field = ? AND path = ? AND status = 'proposed' LIMIT 1")
          .bind(field, args.path)
          .first<{ id: number }>()
      : await deps.db.prepare("SELECT id FROM proposals WHERE field = ? AND status = 'proposed' LIMIT 1")
          .bind(field)
          .first<{ id: number }>();
    if (open) throw new ApiError(`a proposal for this file is already awaiting review (#${open.id})`, 409);
  } else if (field === 'description') {
    const reason = validateDescription(args.value);
    if (reason) throw new ApiError(`invalid description: ${reason}`, 400);
  } else {
    // Title proposals previously bypassed all validation.
    const reason = validateTitle(args.value);
    if (reason) throw new ApiError(`invalid title: ${reason}`, 400);
    // Banned terms are a property of the SITE, not of the description field:
    // a title is published to the same open web. The description path gets this
    // through its injected validator (which closes over deps.config); titles
    // have no validator argument, so the check reads config off deps directly —
    // and stays dormant on a caller that passes no config.
    const banned = findBannedTerm(args.value, deps.config?.bannedTerms);
    if (banned) throw new ApiError(`invalid title: contains banned term "${banned}"`, 400);
  }
  // A resource's current value lives in KV, not in a page snapshot, so the
  // caller supplies it (createLlmsTxtProposal reads it); page fields keep
  // deriving it from the newest snapshot and ignore any supplied value.
  let currentValue: string | null;
  if (resource) {
    currentValue = args.currentValue ?? null;
  } else {
    const snap = await deps.db.prepare('SELECT title, description FROM page_snapshots WHERE path = ? ORDER BY id DESC LIMIT 1')
      .bind(args.path)
      .first<{ title: string | null; description: string | null }>();
    currentValue = (field === 'description' ? snap?.description : snap?.title) ?? null;
  }
  const row = await deps.db.prepare(
    `INSERT INTO proposals (created_at, path, field, current_value, proposed_value, rationale, model)
     VALUES (?, ?, ?, ?, ?, ?, 'manual') RETURNING id`
  )
    .bind(new Date().toISOString(), args.path, field, currentValue, args.value, args.rationale || 'manual')
    .first<{ id: number }>();
  return { ok: true, id: row?.id, status: 'proposed' };
}

export async function dryRunDraft(deps: Pick<AgentDeps, 'db' | 'ai' | 'config'>, path: string | undefined) {
  if (!path) throw new ApiError('path required', 400);
  const snap = await deps.db.prepare('SELECT title, description FROM page_snapshots WHERE path = ? ORDER BY id DESC LIMIT 1')
    .bind(path)
    .first<{ title: string | null; description: string | null }>();
  if (!snap) throw new ApiError('no snapshot for that path — run a crawl first', 404);
  return draftWithTrace(deps, { path, title: snap.title, current: snap.description });
}

export async function listChanges(deps: Pick<AgentDeps, 'db'>) {
  const rows = await deps.db.prepare('SELECT * FROM changes ORDER BY id DESC LIMIT 200').all();
  return rows.results;
}

export async function revertById(deps: Pick<AgentDeps, 'db' | 'overrides'>, changeId: number) {
  const result = await revertChange(deps, changeId);
  if (!result.ok) throw new ApiError(result.error, result.status);
  return { ok: true };
}

export async function listOverrides(deps: Pick<AgentDeps, 'overrides'>) {
  const list = await deps.overrides.list({ prefix: 'override:' });
  return Promise.all(list.keys.map(async (k) => ({ key: k.name, value: await deps.overrides.get(k.name) })));
}
