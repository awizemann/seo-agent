/**
 * Change-impact engine — did an applied override help or hurt the changed page?
 *
 * For every un-reverted change we compare Google Search Console metrics for the
 * changed page across two windows: a BEFORE window ending the day before the
 * change, and an AFTER window that starts a few days later (a settle gap) so the
 * comparison isn't polluted by the transition. Two phases run at different ages:
 * d14 (14-day windows) and d28 (28-day windows). The result is a helped / hurt /
 * neutral / insufficient_data verdict per (change, phase).
 *
 * IMPORTANT — this is CORRELATION, NOT CAUSATION. SEO moves for a hundred
 * reasons (algorithm updates, seasonality, competitors, unrelated site changes,
 * pure query-mix drift). A "hurt" verdict is a prompt to look, never proof the
 * change caused the drop; insufficient_data is a first-class, honest outcome and
 * the common one for low-traffic pages. Thresholds below are deliberately blunt.
 */

import { pageToPath, pageCandidates } from './pagepath.js';
import type { Triggered } from './rules.js';

export { pageToPath };

export type Phase = 'd14' | 'd28';
export type Verdict = 'helped' | 'hurt' | 'neutral' | 'insufficient_data';

// ---------------------------------------------------------------------------
// Verdict thresholds (named + documented; verdictFor is pure and unit-tested).
// ---------------------------------------------------------------------------

/** Below this many total impressions across both windows we won't judge. */
export const MIN_TOTAL_IMPRESSIONS = 50;
/** Relative CTR move that counts as helped/hurt (±15%). */
export const CTR_REL_THRESHOLD = 0.15;
/** Absolute average-position move that counts (1.0 rank; lower = better). */
export const POSITION_ABS_THRESHOLD = 1.0;
/**
 * Impression-volume guard on the position signal. A position gain only counts
 * as "helped" if impressions didn't collapse (>20% down) alongside it; a
 * position loss only counts as "hurt" if impressions didn't surge (>20% up) —
 * a surge in long-tail impressions mechanically dilutes average position
 * without anything being wrong.
 */
export const IMPRESSIONS_GUARD = 0.2;

/** One-paragraph methodology string reused by the README and the MCP tool. */
export const VERDICT_METHODOLOGY =
  'Per change we compare Google Search Console metrics for the changed page ' +
  'across a before-window (ending the day before the change) and an after-window ' +
  '(starting 4 days later, after a settle gap) — 14-day windows for the d14 phase, ' +
  '28-day for d28. Clicks/impressions are stored as per-day rates so unequal ' +
  'effective windows still compare; CTR and position are impression-weighted. ' +
  'Verdict: insufficient_data when the two windows total under ' +
  `${MIN_TOTAL_IMPRESSIONS} impressions or either window has no data; helped when ` +
  `relative CTR rises >=${Math.round(CTR_REL_THRESHOLD * 100)}% or average position ` +
  `improves by >=${POSITION_ABS_THRESHOLD} without impressions dropping more than ` +
  `${Math.round(IMPRESSIONS_GUARD * 100)}%; hurt is the mirror; else neutral ` +
  '(including conflicting signals). This is CORRELATION, not causation.';

export type ImpactMetrics = {
  before_clicks: number; // per-day rate
  after_clicks: number;
  before_impressions: number; // per-day rate
  after_impressions: number;
  before_ctr: number; // impression-weighted
  after_ctr: number;
  before_position: number; // impression-weighted (0 = no impressions/no data)
  after_position: number;
  before_days: number; // distinct dates with data in the before window
  after_days: number;
};

/**
 * Pure verdict function over the computed metrics. Guards every denominator:
 * a before_ctr / before_position of 0 means "no baseline", so that signal is
 * simply not evaluated rather than dividing by zero. Conflicting helped+hurt
 * signals resolve to neutral (honest: the change didn't clearly do either).
 */
export function verdictFor(m: ImpactMetrics): Verdict {
  if (m.before_days <= 0 || m.after_days <= 0) return 'insufficient_data';
  // rate * days === window total exactly (rate was total/days).
  const totalImpressions = m.before_impressions * m.before_days + m.after_impressions * m.after_days;
  if (totalImpressions < MIN_TOTAL_IMPRESSIONS) return 'insufficient_data';

  let ctrHelped = false;
  let ctrHurt = false;
  if (m.before_ctr > 0) {
    const rel = (m.after_ctr - m.before_ctr) / m.before_ctr;
    if (rel >= CTR_REL_THRESHOLD) ctrHelped = true;
    else if (rel <= -CTR_REL_THRESHOLD) ctrHurt = true;
  }

  let posHelped = false;
  let posHurt = false;
  if (m.before_position > 0 && m.after_position > 0) {
    const improvement = m.before_position - m.after_position; // + = moved up (better)
    if (improvement >= POSITION_ABS_THRESHOLD && m.after_impressions >= m.before_impressions * (1 - IMPRESSIONS_GUARD)) {
      posHelped = true;
    } else if (-improvement >= POSITION_ABS_THRESHOLD && m.after_impressions <= m.before_impressions * (1 + IMPRESSIONS_GUARD)) {
      posHurt = true;
    }
  }

  const helped = ctrHelped || posHelped;
  const hurt = ctrHurt || posHurt;
  if (helped && !hurt) return 'helped';
  if (hurt && !helped) return 'hurt';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Window math (UTC, YYYY-MM-DD strings throughout).
// ---------------------------------------------------------------------------

/** Add n days to a YYYY-MM-DD date, UTC, returning YYYY-MM-DD. */
export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const PHASE_DAYS: Record<Phase, number> = { d14: 14, d28: 28 };
const PHASES: Phase[] = ['d14', 'd28'];
const SETTLE_GAP_DAYS = 3; // days after applied_at excluded before the after-window

type Windows = { beforeStart: string; beforeEnd: string; afterStart: string; afterEnd: string };

/**
 * Windows for a change applied on date A (A = applied_at's date). before = the N
 * full days ending the day BEFORE A. after = N days starting after a 3-day settle
 * gap. d14 after-window ends A+17; d28 ends A+31 — that end date is what must be
 * covered by GSC data for the phase to be computable.
 */
export function windowsFor(appliedDate: string, phase: Phase): Windows {
  const n = PHASE_DAYS[phase];
  return {
    beforeStart: addDays(appliedDate, -n),
    beforeEnd: addDays(appliedDate, -1),
    afterStart: addDays(appliedDate, SETTLE_GAP_DAYS + 1),
    afterEnd: addDays(appliedDate, SETTLE_GAP_DAYS + n),
  };
}

// ---------------------------------------------------------------------------
// Metric aggregation from raw gsc_daily rows (already path-matched).
// ---------------------------------------------------------------------------

type GscRow = { date: string; clicks: number; impressions: number; position: number };

type WindowAgg = { clicks: number; impressions: number; posWeighted: number; days: number };

function aggregate(rows: GscRow[], start: string, end: string): WindowAgg {
  const dates = new Set<string>();
  let clicks = 0;
  let impressions = 0;
  let posWeighted = 0;
  for (const r of rows) {
    if (r.date < start || r.date > end) continue;
    dates.add(r.date);
    clicks += r.clicks;
    impressions += r.impressions;
    posWeighted += r.position * r.impressions;
  }
  return { clicks, impressions, posWeighted, days: dates.size };
}

function metricsFor(rows: GscRow[], appliedDate: string, phase: Phase): ImpactMetrics {
  const w = windowsFor(appliedDate, phase);
  const b = aggregate(rows, w.beforeStart, w.beforeEnd);
  const a = aggregate(rows, w.afterStart, w.afterEnd);
  const perDay = (total: number, days: number) => (days > 0 ? total / days : 0);
  const weighted = (num: number, impr: number) => (impr > 0 ? num / impr : 0);
  return {
    before_clicks: perDay(b.clicks, b.days),
    after_clicks: perDay(a.clicks, a.days),
    before_impressions: perDay(b.impressions, b.days),
    after_impressions: perDay(a.impressions, a.days),
    before_ctr: weighted(b.clicks, b.impressions),
    after_ctr: weighted(a.clicks, a.impressions),
    before_position: weighted(b.posWeighted, b.impressions),
    after_position: weighted(a.posWeighted, a.impressions),
    before_days: b.days,
    after_days: a.days,
  };
}

// ---------------------------------------------------------------------------
// The sense: compute newly-computable rows, then emit findings.
// ---------------------------------------------------------------------------

type ChangeRow = { id: number; path: string; field: string; applied_at: string; reverted_at: string | null };

/** Rows of gsc_daily for a path across a date range, matched via pageToPath. */
async function fetchPathRows(env: Env, siteUrl: string, path: string, start: string, end: string): Promise<GscRow[]> {
  const candidates = pageCandidates(path, siteUrl);
  const placeholders = candidates.map(() => '?').join(', ');
  const rows = (
    await env.DB.prepare(
      `SELECT date, page, clicks, impressions, position FROM gsc_daily WHERE date >= ? AND date <= ? AND page IN (${placeholders})`
    )
      .bind(start, end, ...candidates)
      .all<{ date: string; page: string; clicks: number; impressions: number; position: number }>()
  ).results;
  return rows
    .filter((r) => pageToPath(r.page, siteUrl) === path)
    .map((r) => ({ date: r.date, clicks: r.clicks, impressions: r.impressions, position: r.position }));
}

/**
 * Compute any (change, phase) impact rows that are newly computable this run.
 * A phase is computable when GSC data (its own MAX(date), not the wall clock)
 * covers the phase's after-window end. Reverted changes get no NEW rows (any
 * existing rows stay); once a d28 row exists a change is frozen.
 */
export async function computeImpacts(env: Env, siteUrl: string): Promise<number> {
  const maxRow = await env.DB.prepare('SELECT MAX(date) AS d FROM gsc_daily').first<{ d: string | null }>();
  const maxDate = maxRow?.d ?? null;
  if (!maxDate) return 0; // no GSC data — nothing computable

  const changes = (
    await env.DB.prepare('SELECT id, path, field, applied_at, reverted_at FROM changes').all<ChangeRow>()
  ).results;
  const existing = new Set(
    (await env.DB.prepare('SELECT change_id, phase FROM change_impact').all<{ change_id: number; phase: string }>()).results.map(
      (r) => `${r.change_id}|${r.phase}`
    )
  );

  const insert = env.DB.prepare(
    `INSERT OR REPLACE INTO change_impact
       (change_id, phase, computed_at, before_clicks, after_clicks, before_impressions, after_impressions,
        before_ctr, after_ctr, before_position, after_position, verdict)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  const statements = [];

  for (const c of changes) {
    if (c.reverted_at) continue; // no new computations for reverted changes
    if (existing.has(`${c.id}|d28`)) continue; // frozen once d28 exists
    const appliedDate = c.applied_at.slice(0, 10);
    const need = PHASES.filter((p) => !existing.has(`${c.id}|${p}`) && maxDate >= windowsFor(appliedDate, p).afterEnd);
    if (need.length === 0) continue;

    // Fetch once over the widest window needed (d28 ⊇ d14), then compute each phase.
    const span = windowsFor(appliedDate, 'd28');
    const rows = await fetchPathRows(env, siteUrl, c.path, span.beforeStart, span.afterEnd);
    for (const phase of need) {
      const m = metricsFor(rows, appliedDate, phase);
      const verdict = verdictFor(m);
      statements.push(
        insert.bind(
          c.id,
          phase,
          now,
          m.before_clicks,
          m.after_clicks,
          m.before_impressions,
          m.after_impressions,
          m.before_ctr,
          m.after_ctr,
          m.before_position,
          m.after_position,
          verdict
        )
      );
    }
  }

  if (statements.length > 0) await env.DB.batch(statements);
  if (statements.length > 0) console.log(JSON.stringify({ evt: 'impact_computed', rows: statements.length }));
  return statements.length;
}

const pct = (before: number, after: number): string => {
  if (before <= 0) return 'n/a';
  return `${after >= before ? '+' : ''}${Math.round(((after - before) / before) * 100)}%`;
};

/**
 * Impact sense (pipeline). Computes newly-computable rows, then triggers a
 * finding for every un-reverted change whose LATEST phase verdict is hurt
 * (change_hurt, medium) or helped (change_helped, info). Re-triggers every run
 * while the state holds; auto-resolves via the findings lifecycle when the
 * change is reverted or the verdict moves off hurt/helped. GSC-off instances
 * return [] without touching change_impact.
 */
export async function impactFindings(env: Env): Promise<Triggered[]> {
  if (!env.GSC_SERVICE_ACCOUNT_JSON) return []; // GSC not configured (e.g. the eo instance)

  const siteUrl = env.SITE_URL;
  await computeImpacts(env, siteUrl);

  // Latest phase per change (d28 outranks d14), un-reverted only.
  const rows = (
    await env.DB.prepare(
      `WITH ranked AS (
         SELECT ci.change_id, ci.phase, ci.verdict, ci.before_ctr, ci.after_ctr, ci.before_position, ci.after_position,
                ROW_NUMBER() OVER (
                  PARTITION BY ci.change_id
                  ORDER BY CASE ci.phase WHEN 'd28' THEN 2 ELSE 1 END DESC
                ) AS rn
         FROM change_impact ci
         JOIN changes c ON c.id = ci.change_id
         WHERE c.reverted_at IS NULL
       )
       SELECT r.change_id, r.phase, r.verdict, r.before_ctr, r.after_ctr, r.before_position, r.after_position, c.path
       FROM ranked r JOIN changes c ON c.id = r.change_id
       WHERE r.rn = 1 AND r.verdict IN ('hurt', 'helped')`
    ).all<{
      change_id: number;
      phase: string;
      verdict: string;
      before_ctr: number;
      after_ctr: number;
      before_position: number;
      after_position: number;
      path: string;
    }>()
  ).results;

  const out: Triggered[] = [];
  for (const r of rows) {
    const numbers =
      `${r.phase}: CTR ${(r.before_ctr * 100).toFixed(2)}%→${(r.after_ctr * 100).toFixed(2)}% (${pct(r.before_ctr, r.after_ctr)}), ` +
      `position ${r.before_position.toFixed(1)}→${r.after_position.toFixed(1)}`;
    if (r.verdict === 'hurt') {
      out.push({
        path: r.path,
        rule: 'change_hurt',
        severity: 'medium',
        detail: `${numbers} — correlated decline after change #${r.change_id}; consider reverting change #${r.change_id}`,
      });
    } else {
      out.push({
        path: r.path,
        rule: 'change_helped',
        severity: 'info',
        detail: `${numbers} — correlated improvement after change #${r.change_id}`,
      });
    }
  }
  return out;
}
