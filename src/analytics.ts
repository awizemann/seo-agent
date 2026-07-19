/**
 * Analytics assembler — the read-only data behind the dashboard's Analytics
 * section and the get_analytics MCP tool. One SELECT per concern, aggregated in
 * SQL where cheap and in JS where a helper is clearer (and unit-testable).
 *
 * Everything degrades: change_impact / aeo_weekly are added in this version, so
 * on a database upgraded WITHOUT re-running db:init they don't exist and their
 * sub-queries throw. Each such block catches to an empty/active:false shape so
 * the endpoints still return 200 (statusData does the same for aeo/citations).
 */

import { pageToPath, pageCandidates } from './pagepath.js';
import { addDays } from './impact.js';
import { citationConfig } from './citations.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
const todayUTC = () => new Date().toISOString().slice(0, 10);
const dateDaysAgo = (days: number) => addDays(todayUTC(), -days);

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export type FindingRow = { created_at: string; resolved_at: string | null; severity: string };
export type OpenFindingsDay = { date: string; total: number; counts: Record<string, number> };

/**
 * Daily open-finding counts for the last `days` days, grouped by severity. A
 * finding is open on day D (a YYYY-MM-DD string, UTC) when it was created on or
 * before D and is either unresolved or resolved strictly after D. Pure;
 * unit-tested. All comparisons are on date strings — no timezone math.
 */
export function openFindingsSeries(rows: FindingRow[], days: number): OpenFindingsDay[] {
  const today = todayUTC();
  const out: OpenFindingsDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const counts: Record<string, number> = {};
    for (const s of SEVERITIES) counts[s] = 0;
    let total = 0;
    for (const f of rows) {
      const created = (f.created_at || '').slice(0, 10);
      if (!created || created > date) continue;
      const resolved = f.resolved_at ? f.resolved_at.slice(0, 10) : null;
      if (resolved && resolved <= date) continue; // resolved on/before D ⇒ closed on D
      counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      total++;
    }
    out.push({ date, total, counts });
  }
  return out;
}

/** A single path's GSC daily series (impression-weighted ctr/position). */
async function gscDailyForPath(env: Env, path: string, sinceDate: string) {
  const candidates = pageCandidates(path, env.SITE_URL);
  const placeholders = candidates.map(() => '?').join(', ');
  const rows = (
    await env.DB.prepare(
      `SELECT date, page, clicks, impressions, position FROM gsc_daily WHERE date >= ? AND page IN (${placeholders})`
    )
      .bind(sinceDate, ...candidates)
      .all<{ date: string; page: string; clicks: number; impressions: number; position: number }>()
  ).results;
  const byDate = new Map<string, { clicks: number; impressions: number; posWeighted: number }>();
  for (const r of rows) {
    if (pageToPath(r.page, env.SITE_URL) !== path) continue;
    const cur = byDate.get(r.date) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    cur.posWeighted += r.position * r.impressions;
    byDate.set(r.date, cur);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({
      date,
      clicks: v.clicks,
      impressions: v.impressions,
      ctr: v.impressions > 0 ? v.clicks / v.impressions : 0,
      position: v.impressions > 0 ? v.posWeighted / v.impressions : 0,
    }));
}

/** GET /analytics/summary — the whole dashboard payload. */
export async function analyticsSummary(env: Env) {
  const gscSince = dateDaysAgo(90);
  const aeoSince = isoDaysAgo(30);

  const [gscDaily, gscActive] = await Promise.all([
    env.DB.prepare(
      `SELECT date, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
              CASE WHEN SUM(impressions) > 0 THEN CAST(SUM(clicks) AS REAL) / SUM(impressions) ELSE 0 END AS ctr,
              CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE 0 END AS position
       FROM gsc_daily WHERE date >= ? GROUP BY date ORDER BY date`
    )
      .bind(gscSince)
      .all<{ date: string; clicks: number; impressions: number; ctr: number; position: number }>()
      .then((r) => r.results)
      .catch(() => []),
    env.DB.prepare('SELECT COUNT(*) AS n FROM gsc_daily')
      .first<{ n: number }>()
      .then((r) => (r?.n ?? 0) > 0)
      .catch(() => false),
  ]);

  const [aeoDaily, aeoWeekly, topBots] = await Promise.all([
    env.DB.prepare(
      `SELECT substr(ts, 1, 10) AS date,
              SUM(CASE WHEN kind = 'crawler' THEN 1 ELSE 0 END) AS crawler,
              SUM(CASE WHEN kind = 'referral' THEN 1 ELSE 0 END) AS referral,
              SUM(CASE WHEN kind = 'agent' THEN 1 ELSE 0 END) AS agent
       FROM aeo_hits WHERE ts >= ? GROUP BY date ORDER BY date`
    )
      .bind(aeoSince)
      .all<{ date: string; crawler: number; referral: number; agent: number }>()
      .then((r) => r.results)
      .catch(() => []),
    env.DB.prepare('SELECT week_start, kind, bot, served, hits FROM aeo_weekly ORDER BY week_start, kind, bot, served')
      .all<{ week_start: string; kind: string; bot: string | null; served: string; hits: number }>()
      .then((r) => r.results)
      .catch(() => []),
    env.DB.prepare(
      "SELECT bot, COUNT(*) AS hits FROM aeo_hits WHERE kind = 'crawler' AND bot IS NOT NULL AND ts >= ? GROUP BY bot ORDER BY hits DESC LIMIT 10"
    )
      .bind(isoDaysAgo(7))
      .all<{ bot: string; hits: number }>()
      .then((r) => r.results)
      .catch(() => []),
  ]);

  const citSeries = await env.DB.prepare(
    'SELECT checked_at, engine, query, cited, rank FROM citations ORDER BY checked_at, id'
  )
    .all<{ checked_at: string; engine: string; query: string; cited: number; rank: number | null }>()
    .then((r) => r.results)
    .catch(() => []);
  const citCfg = citationConfig(env);
  const citationsActive = citSeries.length > 0 || (citCfg.queries.length > 0 && citCfg.engines.length > 0);

  const findingRows = await env.DB.prepare('SELECT created_at, resolved_at, severity FROM findings')
    .all<FindingRow>()
    .then((r) => r.results)
    .catch(() => [] as FindingRow[]);

  const changes = await changesWithVerdict(env);

  return {
    gsc: { active: gscActive, daily: gscDaily },
    aeo: { daily: aeoDaily, weekly: aeoWeekly, topBots7d: topBots },
    citations: { active: citationsActive, series: citSeries },
    findings: { series: openFindingsSeries(findingRows, 90) },
    changes,
  };
}

/** Changes with their latest-phase verdict merged in (d28 outranks d14). */
async function changesWithVerdict(env: Env) {
  const changes = (
    await env.DB.prepare('SELECT id, path, field, applied_at, reverted_at FROM changes ORDER BY id DESC')
      .all<{ id: number; path: string; field: string; applied_at: string; reverted_at: string | null }>()
  ).results;

  const impactRows = await env.DB.prepare('SELECT change_id, phase, verdict FROM change_impact')
    .all<{ change_id: number; phase: string; verdict: string }>()
    .then((r) => r.results)
    .catch(() => [] as { change_id: number; phase: string; verdict: string }[]);
  const latest = new Map<number, { phase: string; verdict: string }>();
  for (const r of impactRows) {
    const cur = latest.get(r.change_id);
    // d28 outranks d14.
    if (!cur || (r.phase === 'd28' && cur.phase !== 'd28')) latest.set(r.change_id, { phase: r.phase, verdict: r.verdict });
  }

  return changes.map((c) => ({
    ...c,
    latestVerdict: latest.get(c.id)?.verdict ?? null,
    latestPhase: latest.get(c.id)?.phase ?? null,
  }));
}

/** GET /analytics/page?path=/x — one page's GSC series, changes + impact, AI hits. */
export async function analyticsPage(env: Env, path: string) {
  if (!path) return { error: 'path required' };
  const p = pageToPath(path, env.SITE_URL);

  const gsc = await gscDailyForPath(env, p, dateDaysAgo(90)).catch(() => []);

  const changes = (
    await env.DB.prepare('SELECT id, path, field, applied_at, reverted_at, old_value, new_value, source FROM changes WHERE path = ? ORDER BY id DESC')
      .bind(p)
      .all<{ id: number; path: string; field: string; applied_at: string; reverted_at: string | null; old_value: string | null; new_value: string; source: string }>()
  ).results;
  const impactByChange = new Map<number, unknown[]>();
  if (changes.length > 0) {
    const ids = changes.map((c) => c.id);
    const placeholders = ids.map(() => '?').join(', ');
    const impact = await env.DB.prepare(`SELECT * FROM change_impact WHERE change_id IN (${placeholders}) ORDER BY change_id, phase`)
      .bind(...ids)
      .all<{ change_id: number }>()
      .then((r) => r.results)
      .catch(() => [] as { change_id: number }[]);
    for (const row of impact) {
      const list = impactByChange.get(row.change_id) ?? [];
      list.push(row);
      impactByChange.set(row.change_id, list);
    }
  }

  const aeoHits = await env.DB.prepare(
    "SELECT substr(ts, 1, 10) AS date, COUNT(*) AS count FROM aeo_hits WHERE path = ? AND ts >= ? GROUP BY date ORDER BY date"
  )
    .bind(p, isoDaysAgo(30))
    .all<{ date: string; count: number }>()
    .then((r) => r.results)
    .catch(() => []);

  return {
    path: p,
    gsc,
    changes: changes.map((c) => ({ ...c, impact: impactByChange.get(c.id) ?? [] })),
    aeoHits,
  };
}

/** GET /analytics/impact — every change_impact row joined with its change. */
export async function analyticsImpact(env: Env) {
  return env.DB.prepare(
    `SELECT ci.change_id, ci.phase, ci.computed_at,
            ci.before_clicks, ci.after_clicks, ci.before_impressions, ci.after_impressions,
            ci.before_ctr, ci.after_ctr, ci.before_position, ci.after_position, ci.verdict,
            c.path, c.field, c.applied_at, c.reverted_at
     FROM change_impact ci JOIN changes c ON c.id = ci.change_id
     ORDER BY ci.change_id DESC, ci.phase`
  )
    .all()
    .then((r) => r.results)
    .catch(() => []);
}
