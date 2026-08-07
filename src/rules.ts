/**
 * Deterministic rules over the latest crawl. Findings are persistent
 * conditions keyed by (path, rule): a finding opens the first run its
 * condition triggers, stays open while it keeps triggering, and auto-resolves
 * the first run it stops. Event-style rules (new_page / removed_page) resolve
 * on the following run by the same mechanism.
 */

import type { Discovery, PageSnapshot } from './crawl.js';
import type { AgentDeps } from './deps.js';

export type Triggered = { path: string; rule: string; severity: string; detail: string };

/**
 * The discovery sense: how this run found its URLs. In `sitemap` mode there is
 * nothing to say. In `homepage_crawl` mode the site has no usable sitemap —
 * which is a real, if low-severity, SEO condition AND the explanation for why
 * the audit's page list may be short, so it is said once, on `/`, in the same
 * findings lifecycle as everything else (it auto-resolves the first run a
 * sitemap parses).
 *
 * Not DRAFTABLE — there is no copy to write — so `sitemap_missing` stays absent
 * from propose.ts's rule sets and `fieldForRule` returns null for it; a host
 * computing `draftable` from that gets false with no special case. It IS the
 * trigger for sitemap GENERATION (sitemap.ts): an open finding here is exactly
 * the condition under which a managed /sitemap.xml may be proposed, which is
 * how "origin wins" is enforced — the day a real sitemap parses, this finding
 * resolves and the offer goes away with it.
 */
export function discoveryFindings(discovery: Discovery): Triggered[] {
  if (discovery.mode !== 'homepage_crawl') return [];
  return [
    {
      path: '/',
      rule: 'sitemap_missing',
      severity: 'low',
      detail:
        `${discovery.reason}. A sitemap is the list of pages you want search engines to read, ` +
        `with when each last changed — without one they have to guess by following links. ` +
        `We crawled from your homepage instead and found ${discovery.pages} ` +
        `${discovery.pages === 1 ? 'page' : 'pages'}; any page nothing links to would not be in that count. ` +
        `We can build a sitemap out of exactly those pages and serve it for you at /sitemap.xml — ` +
        `you see the file and approve it before anything is served, and the moment your own site starts ` +
        `serving a sitemap we can read, ours steps aside.`,
    },
  ];
}

const DESCRIPTION_MIN = 70;
const DESCRIPTION_MAX = 160;
// A published title is core + brand suffix (TITLE_BRAND_SUFFIX), the suffix
// appended at apply time by `withTitleSuffix` (overrides.ts holds the contract)
// after the core is capped — so a long core is a regression tripwire, not
// routine noise. SERP
// truncation clips from the end (the suffix), and the site name displays
// separately via WebSite JSON-LD, so suffix overflow is tolerated up to a
// sanity bound. When no brand suffix is configured, the core IS the whole title.
// Exported: the drafting pipeline (propose.ts) validates drafted titles against
// the SAME bounds the rules flag them by, so a draft can never satisfy the
// drafter and re-open its own finding on the next crawl.
/**
 * THE canonical a page is supposed to declare: the site origin plus the page's
 * own path (the homepage is the bare origin — the rule accepts the trailing
 * slash too, but this is the form we PUBLISH). Both the rule that raises
 * missing_canonical/canonical_mismatch and the deterministic drafter that
 * fixes them (propose.ts) call this one expression, so a fix can never fail
 * its own verifying recrawl by disagreeing about the expected value.
 */
export function expectedCanonicalUrl(siteOrigin: string, path: string): string {
  // A crawl path is a URL pathname, which may legally carry characters the
  // canonical validator (and an href attribute) can't: an apostrophe, a quote,
  // a stray space in sloppy markup. Percent-encoding those characters names the
  // SAME resource — a decoder gives the path back — in a publishable spelling.
  // It lives HERE, in the shared expression, so the rule that checks a page's
  // canonical and the drafter that fixes it can never disagree about the
  // expected form: whatever this returns is both what the rule accepts and what
  // the fix publishes.
  const safePath = path.replace(/[\s"'<>\\]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `${siteOrigin}${safePath === '/' ? '' : safePath}`;
}

export const TITLE_CORE_MAX = 60;
export const TITLE_TOTAL_MAX = 80;

// Snapshots carry raw HTML text — decode common entities so length checks
// measure what readers see (&amp; is 1 char, not 5). Exported for tests.
export const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    // &amp; LAST: decoding it first turns "&amp;lt;" into "&lt;" then "<" (a
    // double-decode). Doing it last leaves already-escaped entities intact.
    .replace(/&amp;/g, '&');

/**
 * Validate a manual title proposal (AI proposals only ever draft descriptions,
 * so titles previously reached KV unchecked). Minimal: non-empty after trim and
 * no longer than the title rules' sanity bound. Exported for tests. Returns a
 * reason string, or null when valid.
 */
export function validateTitle(text: string): string | null {
  const t = text.trim();
  if (!t) return 'empty after trimming';
  if (t.length > TITLE_TOTAL_MAX) return `too long (${t.length} chars, max ${TITLE_TOTAL_MAX})`;
  return null;
}

export const keyOf = (path: string, rule: string): string => `${path} ${rule}`;

/**
 * Muted (path, rule) keys from a set of findings rows: a key is muted iff its
 * MOST RECENT row (highest id) has status 'dismissed'. A later 'resolved' row
 * (from a restore) or a later 'open' row un-mutes it. Pure and unit-tested.
 *
 * runRules feeds this the single latest row per key (a bounded SQL read), but it
 * also collapses multi-row-per-key input correctly, so a test can pass a whole
 * findings history and get the same answer.
 */
export function mutedKeys(rows: { id: number; path: string; rule: string; status: string }[]): Set<string> {
  const latest = new Map<string, { id: number; status: string }>();
  for (const r of rows) {
    const k = keyOf(r.path, r.rule);
    const cur = latest.get(k);
    if (!cur || r.id > cur.id) latest.set(k, { id: r.id, status: r.status });
  }
  const muted = new Set<string>();
  for (const [k, v] of latest) if (v.status === 'dismissed') muted.add(k);
  return muted;
}

export async function runRules(
  deps: Pick<AgentDeps, 'db' | 'config'>,
  runId: number,
  snapshots: PageSnapshot[],
  // Findings from other check modules (e.g. aeo.ts) that share the same
  // (path, rule) open/auto-resolve lifecycle and land in the same upsert.
  extraTriggered: Triggered[] = [],
  // How this run's URLs were found. In homepage_crawl mode there IS no sitemap,
  // so a URL that fails to load cannot be a sitemap problem — it is a broken
  // internal link, and "remove it from the sitemap" is not a fix anyone can do.
  discovery?: Discovery
): Promise<{ opened: number; resolved: number; open: number }> {
  const fromLinks = discovery?.mode === 'homepage_crawl';
  const cfg = deps.config;
  const siteOrigin = new URL(cfg.siteUrl).origin;
  const triggered: Triggered[] = [...extraTriggered];
  const add = (path: string, rule: string, severity: string, detail: string) =>
    triggered.push({ path, rule, severity, detail });

  const titleGroups = new Map<string, string[]>();

  for (const s of snapshots) {
    if (s.status === 0 || s.status >= 400) {
      add(
        s.path,
        fromLinks ? 'broken_internal_link' : 'sitemap_url_error',
        'high',
        s.error ? `fetch error: ${s.error}` : `HTTP ${s.status}`
      );
      continue; // head fields are meaningless on errors/redirects
    }
    if (s.status >= 300) {
      // homepageCrawl follows same-origin redirects instead of snapshotting the
      // hop (crawl.ts), so a 3xx snapshot here is a sitemap-mode fact; if one
      // ever slips through in link mode (e.g. a 3xx with no Location) there is
      // no sitemap to correct, so it raises nothing.
      if (!fromLinks) {
        add(s.path, 'sitemap_url_redirects', 'medium', `HTTP ${s.status} — sitemap should list final URLs`);
      }
      continue;
    }

    if (s.title) {
      const title = decodeEntities(s.title);
      const key = title.trim().toLowerCase();
      titleGroups.set(key, [...(titleGroups.get(key) ?? []), s.path]);
      if (cfg.shellTitle && title === cfg.shellTitle && s.path !== '/') {
        add(s.path, 'injection_regression', 'critical', 'page serves the static shell title — edge SEO layer did not run (fail-open?)');
      }
      // These run on the DELIVERED title, which is core + suffix (whether the
      // origin bakes it in or we appended it at apply time — see
      // `withTitleSuffix` in overrides.ts). Stripping one suffix off the end
      // recovers the core the bounds are written against.
      const suffix = cfg.titleBrandSuffix;
      const core = suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
      if (core.length > TITLE_CORE_MAX || title.length > TITLE_TOTAL_MAX) {
        add(s.path, 'long_title', 'low', `core ${core.length} chars (max ${TITLE_CORE_MAX}), total ${title.length} (max ${TITLE_TOTAL_MAX}): ${title}`);
      }
      // Tripwire: after stripping ONE trailing suffix above, the core still
      // ends with the suffix — i.e. the delivered title carries it TWICE. Our
      // own publish path cannot cause this (applyOverride appends only when the
      // value doesn't already end with the suffix), so a hit means the origin
      // bakes the suffix into a core we then suffixed, or an operator stored a
      // pre-suffixed title by hand.
      if (suffix && core.endsWith(suffix)) {
        add(s.path, 'doubled_title_suffix', 'high', `title carries the site suffix twice: ${title}`);
      }
    } else {
      add(s.path, 'missing_title', 'critical', 'no <title> delivered');
    }

    const description = s.description === null ? null : decodeEntities(s.description);
    if (!description) {
      add(s.path, 'missing_description', 'high', 'no meta description delivered');
    } else if (description.endsWith('...')) {
      // The formatter word-truncates over-length source copy to exactly the
      // max — so a delivered "..." means the SOURCE overflows, which a plain
      // length check can never see. Mid-thought ellipses read badly in SERPs.
      add(s.path, 'truncated_description', 'medium', `delivered description is a truncation of over-length source copy: ${description}`);
    } else if (description.length < DESCRIPTION_MIN) {
      add(s.path, 'short_description', 'medium', `${description.length} chars (min ${DESCRIPTION_MIN}): ${description}`);
    } else if (description.length > DESCRIPTION_MAX) {
      add(s.path, 'long_description', 'medium', `${description.length} chars (max ${DESCRIPTION_MAX})`);
    }

    const expectedCanonical = expectedCanonicalUrl(siteOrigin, s.path);
    // The homepage canonical is equivalent with or without the trailing slash;
    // don't flag that difference (some sites emit "origin/", others "origin").
    const canonicalOk = s.canonical === expectedCanonical || (s.path === '/' && s.canonical === `${siteOrigin}/`);
    if (!s.canonical) {
      add(s.path, 'missing_canonical', 'medium', 'no canonical link delivered');
    } else if (!canonicalOk) {
      add(s.path, 'canonical_mismatch', 'high', `canonical is ${s.canonical}, expected ${expectedCanonical}`);
    }

    if (!s.ogImage) add(s.path, 'missing_og_image', 'medium', 'no og:image delivered');
    if (s.noindex) add(s.path, 'noindex_in_sitemap', 'high', 'page is noindexed but listed in the sitemap');
    if (cfg.articlePathPrefix && s.path.startsWith(cfg.articlePathPrefix) && !s.jsonldTypes.includes('Article')) {
      add(s.path, 'missing_article_jsonld', 'medium', `article page without Article JSON-LD (saw: ${s.jsonldTypes.join(', ') || 'none'})`);
    }
  }

  for (const [, paths] of titleGroups) {
    if (paths.length > 1) {
      for (const p of paths) add(p, 'duplicate_title', 'medium', `same title as: ${paths.filter((x) => x !== p).join(', ')}`);
    }
  }

  // New/removed pages vs the previous successful run (first run = baseline, no events).
  const prev = await deps.db.prepare('SELECT id FROM crawl_runs WHERE id < ? AND ok = 1 ORDER BY id DESC LIMIT 1')
    .bind(runId)
    .first<{ id: number }>();
  if (prev) {
    const prevPaths = new Set(
      (await deps.db.prepare('SELECT path FROM page_snapshots WHERE run_id = ?').bind(prev.id).all<{ path: string }>()).results.map(
        (r) => r.path
      )
    );
    const currentPaths = new Set(snapshots.map((s) => s.path));
    for (const s of snapshots) {
      if (!prevPaths.has(s.path)) add(s.path, 'new_page', 'info', 'first appearance in the sitemap — onboarding checks ran this crawl');
    }
    for (const p of prevPaths) {
      if (!currentPaths.has(p)) add(p, 'removed_page', 'info', 'no longer in the sitemap');
    }
  }

  // Upsert against open findings: open the new, resolve the cleared.
  const openRows = (
    await deps.db.prepare("SELECT id, path, rule FROM findings WHERE status = 'open'").all<{ id: number; path: string; rule: string }>()
  ).results;
  const openKeys = new Map(openRows.map((r) => [keyOf(r.path, r.rule), r.id]));
  // Muted keys: a (path, rule) a human dismissed. Skip inserting its triggered
  // finding so a dismissal doesn't silently re-open every day. The subquery
  // returns just the LATEST row per (path, rule); mutedKeys keeps those still
  // 'dismissed' (a restore turns that row 'resolved', lifting the mute). The
  // resolve loop below only walks openKeys, so it never touches dismissed rows.
  const latestPerKey = (
    await deps.db.prepare(
      `SELECT f.id AS id, f.path AS path, f.rule AS rule, f.status AS status
       FROM findings f
       JOIN (SELECT path, rule, MAX(id) AS mid FROM findings GROUP BY path, rule) m
         ON f.path = m.path AND f.rule = m.rule AND f.id = m.mid`
    ).all<{ id: number; path: string; rule: string; status: string }>()
  ).results;
  const dismissedKeys = mutedKeys(latestPerKey);
  // Dedupe the triggered list within the run: duplicate sitemap entries (or a
  // self-join in duplicate_title) can push the same (path, rule) twice, which
  // would otherwise double-insert the same open finding. Keep first occurrence.
  const seenTriggered = new Set<string>();
  const uniqueTriggered = triggered.filter((t) => {
    const k = keyOf(t.path, t.rule);
    if (seenTriggered.has(k)) return false;
    seenTriggered.add(k);
    return true;
  });
  const triggeredKeys = new Set(uniqueTriggered.map((t) => keyOf(t.path, t.rule)));

  const now = new Date().toISOString();
  const statements = [];
  const insert = deps.db.prepare('INSERT INTO findings (created_at, run_id, path, rule, severity, detail) VALUES (?, ?, ?, ?, ?, ?)');
  let opened = 0;
  for (const t of uniqueTriggered) {
    const k = keyOf(t.path, t.rule);
    if (openKeys.has(k)) continue; // already open — leave it
    if (dismissedKeys.has(k)) continue; // muted — a human dismissed it; don't re-open
    statements.push(insert.bind(now, runId, t.path, t.rule, t.severity, t.detail));
    opened++;
  }
  const resolve = deps.db.prepare("UPDATE findings SET status = 'resolved', resolved_at = ? WHERE id = ?");
  let resolved = 0;
  for (const [key, id] of openKeys) {
    if (!triggeredKeys.has(key)) {
      statements.push(resolve.bind(now, id));
      resolved++;
    }
  }
  if (statements.length > 0) await deps.db.batch(statements);

  console.log(JSON.stringify({ evt: 'rules_complete', runId, opened, resolved, open: triggeredKeys.size }));
  return { opened, resolved, open: triggeredKeys.size };
}
