/**
 * Override verification — did the edge SEO layer actually SERVE what we
 * approved?
 *
 * Every applied page change lands in KV at `override:<path>` as
 * `{title?, description?}`, and the injector merges those fields into the
 * page's <head> on every request. The crawl then records what was really
 * delivered per path. So the library already holds both halves of the answer:
 * expected (KV) vs delivered (snapshot). When they disagree on a page that
 * answered 2xx, the injector is not running — a fail-open route miss, an
 * expired/wrong KV binding, a cache serving a pre-override copy forever, a
 * deploy that dropped the SEO worker. That is the same failure the
 * `injection_regression` rule in rules.ts already names, so this sense emits
 * the SAME rule id (see the dedupe note below).
 *
 * Why this exists next to that rule: the rules.ts detector only fires when
 * `SHELL_TITLE` is configured, which most deployments never set. This one is
 * config-free — it needs only overrides that exist and a crawl that ran.
 *
 * Deliberate non-goals:
 *  - RESOURCE overrides (`resource:<path>` — /llms.txt, /robots.txt, .md twins)
 *    are NOT checked. The crawl only fetches sitemap pages and parses their
 *    <head>; it never fetches those resource paths, so there is no delivered
 *    value to compare against. Half-checking them (e.g. inferring from a 404)
 *    would produce confident-sounding noise, so they are out of scope until the
 *    crawl actually samples them.
 *  - Paths not crawled this run are skipped: no evidence either way.
 *  - Non-2xx snapshots are skipped: head fields on an error/redirect are
 *    meaningless (rules.ts skips them for the same reason).
 */

import type { PageSnapshot } from './crawl.js';
import type { AgentDeps } from './deps.js';
import { decodeEntities, type Triggered } from './rules.js';

/** KV page size for the override listing (the platform max). */
const LIST_PAGE_SIZE = 1000;
/**
 * Hard bound on how much of the override space we walk in one run. A site with
 * more approved overrides than this has bigger problems than this sense; the
 * cap keeps a runaway key space from turning one pipeline stage into an
 * unbounded KV scan. Verification is best-effort by design.
 */
const MAX_OVERRIDE_KEYS = 5000;

/** Longest value echoed into a finding detail before it gets an ellipsis. */
const DETAIL_VALUE_MAX = 120;

export type OverrideEntry = { path: string; title?: string; description?: string };

/** A value as it reads in a finding detail: single-line and length-capped. */
export function truncateValue(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_VALUE_MAX ? `${flat.slice(0, DETAIL_VALUE_MAX - 1)}…` : flat;
}

/**
 * Compare two head values the way a reader would, not the way bytes do.
 *
 * Mirrors what the injector + the crawl do to a stored string on the round
 * trip. The injector writes the raw stored text into the document
 * (`setInnerContent` for <title>, `setAttribute('content', …)` for the metas),
 * which HTML-escapes it; the crawl reads it back as raw HTML text and only
 * trims the title. So the round trip can legitimately turn `A & B` into
 * `A &amp; B`, and can legitimately re-wrap whitespace inside <title>. Neither
 * is a regression, so both are normalized away here — the same entity decoding
 * rules.ts applies before its own length checks, plus whitespace folding.
 */
export function normalizeDelivered(value: string): string {
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

/**
 * The title the injector is expected to have delivered for a stored core.
 *
 * The stored value is the CORE only — the site's edge layer appends
 * TITLE_BRAND_SUFFIX itself (see the title drafting prompt in propose.ts and
 * the suffix-stripping in rules.ts, which both hold this contract). So the
 * expected delivered title is core + suffix, EXCEPT when the stored core
 * already ends with the suffix: that is the `doubled_title_suffix` bug, which
 * has its own rule and its own finding, and re-flagging it here as an injection
 * regression would blame the injector for a content problem.
 */
export function expectedTitle(core: string, suffix: string): string {
  const c = core.trim();
  if (!suffix) return c;
  return c.endsWith(suffix.trim()) ? c : `${c}${suffix}`;
}

/**
 * The pure core: which overrides are provably not being served.
 *
 * Exported for tests — the async wrapper below only adds the KV listing.
 */
export function verifyOverrides(entries: OverrideEntry[], snapshots: PageSnapshot[], suffix: string): Triggered[] {
  const byPath = new Map(snapshots.map((s) => [s.path, s]));
  const out: Triggered[] = [];
  for (const entry of entries) {
    const snap = byPath.get(entry.path);
    if (!snap) continue; // not crawled this run — no evidence either way
    if (snap.status < 200 || snap.status >= 300) continue; // head fields meaningless

    const mismatches: string[] = [];
    if (entry.title) {
      const expected = normalizeDelivered(expectedTitle(entry.title, suffix));
      const delivered = normalizeDelivered(snap.title ?? '');
      if (expected && expected !== delivered) {
        mismatches.push(
          `title: expected "${truncateValue(expected)}", delivered ${snap.title ? `"${truncateValue(delivered)}"` : 'nothing'}`
        );
      }
    }
    if (entry.description) {
      const expected = normalizeDelivered(entry.description);
      const delivered = normalizeDelivered(snap.description ?? '');
      if (expected && expected !== delivered) {
        mismatches.push(
          `description: expected "${truncateValue(expected)}", delivered ${
            snap.description ? `"${truncateValue(delivered)}"` : 'nothing'
          }`
        );
      }
    }
    if (mismatches.length === 0) continue;

    out.push({
      path: entry.path,
      rule: 'injection_regression',
      severity: 'critical',
      detail: `approved override is not being served — ${mismatches.join('; ')}`,
    });
  }
  return out;
}

/**
 * Page the `override:` key space (bounded — see MAX_OVERRIDE_KEYS) and read
 * each entry. Malformed JSON reads as "no override", matching readOverride's
 * fail-soft posture.
 */
export async function listPageOverrides(deps: Pick<AgentDeps, 'overrides'>): Promise<OverrideEntry[]> {
  const entries: OverrideEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page * LIST_PAGE_SIZE < MAX_OVERRIDE_KEYS; page++) {
    const res = await deps.overrides.list({ prefix: 'override:', limit: LIST_PAGE_SIZE, cursor });
    for (const k of res.keys) {
      const path = k.name.slice('override:'.length);
      if (!path) continue;
      const raw = await deps.overrides.get(k.name);
      if (!raw) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const title = typeof parsed.title === 'string' ? parsed.title : undefined;
      const description = typeof parsed.description === 'string' ? parsed.description : undefined;
      if (!title && !description) continue;
      entries.push({ path, title, description });
    }
    if (res.list_complete || !res.cursor) return entries;
    cursor = res.cursor;
  }
  console.warn(JSON.stringify({ evt: 'override_verify_truncated', scanned: entries.length, cap: MAX_OVERRIDE_KEYS }));
  return entries;
}

/**
 * The sense entry point, wired into runPipeline beside aeo/telemetry/impact and
 * isolated the same way (a throw degrades to zero findings from this sense).
 */
export async function overrideVerificationFindings(
  deps: Pick<AgentDeps, 'overrides' | 'config'>,
  snapshots: PageSnapshot[]
): Promise<Triggered[]> {
  if (snapshots.length === 0) return [];
  const entries = await listPageOverrides(deps);
  return verifyOverrides(entries, snapshots, deps.config.titleBrandSuffix);
}
