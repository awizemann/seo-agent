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
 *  - The `jsonld` page field is NOT checked. The crawl records `jsonld_types`
 *    (which @types a page delivered), never the JSON-LD source text, so there is
 *    no delivered value to compare a stored document against. Presence of the
 *    expected @type would be a weaker, different claim than the byte equality
 *    this sense makes about title and description, and reporting it under the
 *    same critical `injection_regression` rule would overstate it. Out of scope
 *    until the crawl captures the block itself.
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

/** Fold whitespace the way a <title> renderer does. Applied to BOTH sides. */
const foldSpace = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * The DELIVERED side of the comparison, undone back to the string we stored.
 *
 * The round trip is: we PUT a raw string into KV → the injector writes it into
 * the document (`setInnerContent` for <title>, `setAttribute('content', …)` for
 * the metas), which HTML-ESCAPES it → the crawl reads it back as raw HTML text.
 * So the delivered text is `escape(stored)`, and decoding it exactly once
 * recovers `stored`. `A & B` legitimately arrives as `A &amp; B`, and <title>
 * whitespace can legitimately be re-wrapped; neither is a regression.
 *
 * Audit M4 — this is why the decode is applied to the DELIVERED side ONLY, not
 * to both. A stored value may itself contain a literal entity (an operator
 * pasted `Tips &amp; Tricks`, meaning those nine characters); the injector
 * escapes it again, so the crawl sees `Tips &amp;amp; Tricks`. One decode of
 * the delivered side gives back the stored `Tips &amp; Tricks` and matches.
 * Decoding BOTH sides would compare `Tips &amp; Tricks` against
 * `Tips & Tricks` and emit a false critical. Escaping is not idempotent, so the
 * comparison cannot be either.
 */
export function normalizeDelivered(value: string): string {
  return foldSpace(decodeEntities(value));
}

/**
 * The EXPECTED side: the stored value with whitespace folded and nothing else.
 * Deliberately NOT entity-decoded — see normalizeDelivered (audit M4).
 */
export function normalizeExpected(value: string): string {
  return foldSpace(value);
}

/**
 * The title the injector is expected to have delivered for a stored value:
 * the stored value itself, VERBATIM.
 *
 * No suffix model. The injector's `setInnerContent` REPLACES the origin
 * <title> with the stored string and appends nothing, and since v1.15.1 the
 * stored string is already the full served value — the brand suffix is
 * appended at apply time, in `withTitleSuffix`/`applyOverride` (overrides.ts
 * holds the contract). The pre-1.15.1 version of this function expected
 * core + TITLE_BRAND_SUFFIX and so flagged every drafted title as a false
 * critical `injection_regression`.
 *
 * Kept as a named export because the round trip still needs naming: the caller
 * runs this through `normalizeExpected` and the crawled value through
 * `normalizeDelivered`, which is what keeps a stored literal entity from
 * false-positiving (audit M4).
 */
export function expectedTitle(stored: string): string {
  return stored.trim();
}

/**
 * The pure core: which overrides are provably not being served.
 *
 * Exported for tests — the async wrapper below only adds the KV listing.
 */
export function verifyOverrides(entries: OverrideEntry[], snapshots: PageSnapshot[]): Triggered[] {
  const byPath = new Map(snapshots.map((s) => [s.path, s]));
  const out: Triggered[] = [];
  for (const entry of entries) {
    const snap = byPath.get(entry.path);
    if (!snap) continue; // not crawled this run — no evidence either way
    if (snap.status < 200 || snap.status >= 300) continue; // head fields meaningless

    const mismatches: string[] = [];
    if (entry.title) {
      // The delivered side is decoded once (it is escape(stored)); the stored
      // side is not. See normalizeDelivered — audit M4.
      const expected = normalizeExpected(expectedTitle(entry.title));
      const delivered = normalizeDelivered(snap.title ?? '');
      if (expected && expected !== delivered) {
        mismatches.push(
          `title: expected "${truncateValue(expected)}", delivered ${snap.title ? `"${truncateValue(delivered)}"` : 'nothing'}`
        );
      }
    }
    if (entry.description) {
      // Same asymmetry as the title lane, for the same reason (audit M4).
      const expected = normalizeExpected(entry.description);
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
  deps: Pick<AgentDeps, 'overrides'>,
  snapshots: PageSnapshot[]
): Promise<Triggered[]> {
  if (snapshots.length === 0) return [];
  const entries = await listPageOverrides(deps);
  return verifyOverrides(entries, snapshots);
}
