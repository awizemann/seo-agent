/**
 * AI traffic telemetry — the read side. The SITE writes rows into `aeo_hits`
 * (its injector / edge Worker binds this agent's D1 as TELEMETRY and inserts
 * fire-and-forget for AI-relevant requests only: known AI-bot UAs, human
 * referrals from AI engines, and markdown-lane responses). This module
 * aggregates for status/dashboard/MCP, folds two low-noise rules into the
 * findings lifecycle, and prunes old rows.
 */

import type { Triggered } from './rules.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;

const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

export type TelemetrySummary = {
  active: boolean; // any rows at all — i.e. a site-side tap is wired up
  lastHit: string | null;
  crawler7d: { bot: string; n: number }[];
  referral7d: number;
  md7d: number;
};

export async function telemetrySummary(env: Env): Promise<TelemetrySummary> {
  const since = isoDaysAgo(7);
  const [last, crawlers, referrals, md] = await Promise.all([
    env.DB.prepare('SELECT MAX(ts) AS ts FROM aeo_hits').first<{ ts: string | null }>(),
    env.DB.prepare("SELECT bot, COUNT(*) AS n FROM aeo_hits WHERE kind = 'crawler' AND ts >= ? GROUP BY bot ORDER BY n DESC")
      .bind(since)
      .all<{ bot: string; n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM aeo_hits WHERE kind = 'referral' AND ts >= ?").bind(since).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM aeo_hits WHERE served = 'md' AND ts >= ?").bind(since).first<{ n: number }>(),
  ]);
  return {
    active: !!last?.ts,
    lastHit: last?.ts ?? null,
    crawler7d: crawlers.results,
    referral7d: referrals?.n ?? 0,
    md7d: md?.n ?? 0,
  };
}

export async function listCrawlerHits(env: Env, days = 7, limit = 200) {
  const rows = await env.DB.prepare(
    'SELECT ts, kind, bot, referrer, path, status, served FROM aeo_hits WHERE ts >= ? ORDER BY id DESC LIMIT ?'
  )
    .bind(isoDaysAgo(Math.min(Math.max(days, 1), RETENTION_DAYS)), Math.min(Math.max(limit, 1), 500))
    .all();
  return rows.results;
}

/**
 * Two deliberately low-noise rules:
 *  - ai_crawlers_silent (info): the tap has been active ≥14 days but NO AI
 *    crawler hit arrived in the last 14 — the site is invisible to AI engines
 *    or something started blocking them.
 *  - ai_crawler_errors (medium): a bot with ≥5 hits in 7 days is getting >20%
 *    4xx/5xx — something is broken specifically for that crawler.
 */
export async function telemetryFindings(env: Env): Promise<Triggered[]> {
  const out: Triggered[] = [];
  const cutoff14 = isoDaysAgo(14);

  const oldest = await env.DB.prepare('SELECT MIN(ts) AS ts FROM aeo_hits').first<{ ts: string | null }>();
  if (!oldest?.ts) return out; // no tap wired up — nothing to say
  if (oldest.ts <= cutoff14) {
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM aeo_hits WHERE kind = 'crawler' AND ts >= ?")
      .bind(cutoff14)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) === 0) {
      out.push({
        path: '/telemetry',
        rule: 'ai_crawlers_silent',
        severity: 'info',
        detail: 'telemetry is active but no AI crawler has fetched the site in 14 days — check indexability/robots/CDN bot settings, or the site simply is not on AI engines’ radar yet',
      });
    }
  }

  const errRows = await env.DB.prepare(
    "SELECT bot, COUNT(*) AS n, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errs FROM aeo_hits WHERE kind = 'crawler' AND ts >= ? GROUP BY bot HAVING n >= 5"
  )
    .bind(isoDaysAgo(7))
    .all<{ bot: string; n: number; errs: number }>();
  for (const r of errRows.results) {
    if (r.errs / r.n > 0.2) {
      out.push({
        path: `/telemetry/${r.bot}`,
        rule: 'ai_crawler_errors',
        severity: 'medium',
        detail: `${r.bot}: ${r.errs}/${r.n} requests errored (4xx/5xx) in the last 7 days`,
      });
    }
  }
  return out;
}

export async function pruneTelemetry(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM aeo_hits WHERE ts < ?').bind(isoDaysAgo(RETENTION_DAYS)).run();
}
