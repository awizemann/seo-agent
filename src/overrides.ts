/**
 * KV override plumbing. Overrides live at `override:<path>` as a JSON object
 * of field → value (fields: description, title, jsonld). The site Worker's edge
 * SEO layer merges them over its computed meta on every page request, so an
 * approved change is live within the KV cache TTL — no deploy. Every apply
 * and revert lands in the `changes` journal.
 *
 * Site-level FILES (/llms.txt, /robots.txt) ride the same journal but a different
 * key space — `resource:<path>`, holding the whole file — see RESOURCE_FIELDS.
 */

import type { AgentDeps } from './deps.js';

/**
 * The page fields an override object may carry — the single enumeration every
 * other module gates on (createProposal's field check, the MCP tool enum, the
 * "already live" proposal query in listFindings). A field absent from here can
 * never reach KV: applyOverride refuses it.
 */
export const OVERRIDE_FIELDS = new Set(['description', 'title', 'jsonld']);

// ---------------------------------------------------------------------------
// JSON-LD (structured data), the third page field.
//
// The stored value is the JSON-LD document as JSON TEXT — no <script> wrapper.
// The wrapper is the injector's job, so the same stored bytes serve whether the
// consumer is the proxy injector, a site's own edge layer, or the wire API.
//
// THE STORED VALUE IS INERT BY CONSTRUCTION. `checkJsonLd` does not merely
// validate, it RE-SERIALIZES: the text that lands in KV is JSON.stringify of
// the parsed document with every `<` and `>` written as its \u003c / \u003e
// escape. Those escapes are ordinary JSON — a parser yields the original
// characters — so the document is unchanged for any reader, while the bytes
// themselves cannot close the enclosing <script> element or open an HTML
// comment. This is why the check is a normalizer and not a predicate: rejecting
// "</" would leave the door open to every other spelling of the same trick
// (`<\/script`, `<!--`, a `<` arriving from a JSON \u escape in the input), and
// each of those would then have to be enumerated. Escaping `<` closes all of
// them at once, and it is the standard practice for JSON in HTML.
//
// NO HTML ENTITIES: `&lt;` in a JSON-LD block is data, not markup — an entity
// would change the value a parser reads. The escaping is JSON's, never HTML's.
// ---------------------------------------------------------------------------

/**
 * Sanity bound on a stored JSON-LD document, measured on the CANONICAL
 * serialization (the bytes actually served). Article/Organization/Product nodes
 * are a few hundred bytes; 8 KB is room for a rich node with a long
 * description and still small enough that it can never dominate a page's
 * <head>. Far under the resource bound (RESOURCE_MAX_CHARS) on purpose: this
 * one ships inline on every HTML response.
 */
export const JSONLD_MAX_CHARS = 8192;

export type JsonLdCheck = { ok: true; value: string } | { ok: false; reason: string };

/** A `@type` is usable when it is a non-blank string, or a non-empty array of them. */
function typeReason(type: unknown): string | null {
  if (typeof type === 'string') return type.trim() ? null : '"@type" is empty';
  if (Array.isArray(type)) {
    if (type.length === 0) return '"@type" is an empty array';
    return type.every((t) => typeof t === 'string' && t.trim()) ? null : '"@type" array must hold non-empty strings';
  }
  return type === undefined ? 'missing "@type"' : '"@type" must be a string or an array of strings';
}

/**
 * `@context` must point at schema.org. The value has three legal shapes — a
 * string, an array, or an object of term definitions — so the test is on the
 * serialized context rather than on one of them, which keeps a legitimate
 * `["https://schema.org", {...}]` working without enumerating shapes.
 */
function contextReason(context: unknown): string | null {
  if (context === undefined) return 'missing "@context"';
  return JSON.stringify(context)?.includes('schema.org') ? null : '"@context" must reference schema.org';
}

/**
 * Every node in the document must stand on its own — see checkJsonLd.
 *
 * `label` prefixes the reason so an array rejection names the offending node
 * ("node 1: missing \"@context\""); the single-object case passes '' because
 * there is only one thing it could be talking about. The reason is read by a
 * human reviewing a 400, and by the model on the drafting retry turn, so
 * "which one" is worth the four characters.
 */
function nodeReason(node: unknown, label: string): string | null {
  const at = (reason: string) => (label ? `${label}: ${reason}` : reason);
  if (!node || typeof node !== 'object' || Array.isArray(node)) return at('must be a JSON object');
  const o = node as Record<string, unknown>;
  const reason = contextReason(o['@context']) ?? typeReason(o['@type']);
  return reason ? at(reason) : null;
}

/**
 * Validate and canonicalize a JSON-LD document. Fail-closed: every caller that
 * can put bytes on a page (apply, manual proposal, AI draft) runs THIS, so
 * there is one answer to "is this publishable" and one canonical form.
 *
 * The rules, all of them:
 *  - parses as JSON, to an object or a non-empty array of objects;
 *  - EVERY node carries a schema.org `@context` and a non-empty `@type`. An
 *    array is a list of independent top-level nodes — JSON-LD gives them no
 *    shared context — so each is checked as if it were alone. A single node
 *    with `@graph` is the way to share one context, and that is one object,
 *    checked once;
 *  - the canonical serialization fits JSONLD_MAX_CHARS.
 *
 * On success `value` is what to store: re-serialized, with `<`/`>` escaped so
 * the text is safe as the body of a <script> element (see the note above).
 */
export function checkJsonLd(text: string): JsonLdCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { ok: false, reason: 'empty array — nothing to publish' };
    for (const [i, node] of parsed.entries()) {
      const reason = nodeReason(node, `node ${i}`);
      if (reason) return { ok: false, reason };
    }
  } else {
    const reason = nodeReason(parsed, '');
    if (reason) return { ok: false, reason };
  }

  const value = JSON.stringify(parsed).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  if (value.length > JSONLD_MAX_CHARS) {
    return { ok: false, reason: `too long (${value.length} chars, max ${JSONLD_MAX_CHARS})` };
  }
  return { ok: true, value };
}

/** Why a JSON-LD document is unpublishable, or null — the shape the drafting
 *  validators use (invalidReason / invalidTitleReason are its siblings). */
export function invalidJsonLdReason(text: string): string | null {
  const check = checkJsonLd(text);
  return check.ok ? null : check.reason;
}

/**
 * THE TITLE SUFFIX CONTRACT (single source of truth — v1.15.1).
 *
 * A stored `override:<path>` value is the FULL value the injector serves,
 * verbatim. The injector's `setInnerContent(o.title)` REPLACES the origin's
 * whole <title> — it appends nothing — so anything not in the stored string is
 * simply not delivered. Before v1.15.1 three modules assumed the site's edge
 * layer appended TITLE_BRAND_SUFFIX to a stored core; nothing did, and served
 * titles silently lost their brand suffix.
 *
 * So the suffix is appended HERE, at apply time, on the way into KV:
 *
 *  - proposal row  → the CORE the reviewer judged (unsuffixed). Re-approving
 *    after a TITLE_BRAND_SUFFIX change therefore re-appends the CURRENT suffix.
 *  - KV override   → core + suffix, the exact string the injector serves.
 *
 * `applyOverride` is the one choke point every title publish flows through
 * (proposal approval in actions.ts `decideProposal`, and the auto-apply branch
 * of propose.ts `draftAndCreate`), so the append lives there and nowhere else.
 *
 * Downstream consequences, kept in sync by this comment:
 *  - verify.ts compares the stored value VERBATIM (no suffix model).
 *  - rules.ts strips the suffix off a DELIVERED title before its core-length
 *    math, and its `doubled_title_suffix` tripwire fires only when the suffix
 *    appears TWICE — impossible from our own path, since we append only when
 *    the value does not already end with it.
 *  - propose.ts still drafts (and validates) the CORE: the drafter must not
 *    write the suffix, because this function adds it.
 */
export function withTitleSuffix(value: string, suffix: string): string {
  if (!suffix) return value;
  return value.endsWith(suffix) ? value : `${value}${suffix}`;
}

/**
 * The value that actually lands in KV for a field. Only `title` carries the
 * brand suffix; a description is stored exactly as approved; `jsonld` is
 * validated and re-serialized into its canonical, script-safe form.
 *
 * The jsonld branch THROWS on an invalid document rather than storing it. This
 * is the fail-closed edge: applyOverride is the one path into KV for a page
 * field, it calls this, and so nothing that fails `checkJsonLd` can ever be
 * served — whatever validated (or failed to validate) upstream at draft or
 * proposal time.
 */
export function storedOverrideValue(field: string, value: string, suffix: string | undefined): string {
  if (field === 'jsonld') {
    const check = checkJsonLd(value);
    if (!check.ok) throw new Error(`invalid jsonld: ${check.reason}`);
    return check.value;
  }
  return field === 'title' ? withTitleSuffix(value, suffix || '') : value;
}

/**
 * RESOURCE fields are the second kind of override. A page override merges
 * fields into a page's delivered <head>; a resource override REPLACES a whole
 * site-level file the injector serves straight from KV, at
 * `resource:<path>` → JSON {contentType, body}.
 *
 * The field name identifies the resource, so its path and content type are
 * pinned HERE rather than supplied per call — a caller can never publish
 * arbitrary bytes at an arbitrary path through the proposal flow. Resources
 * ride the same proposals → changes → revert lifecycle as page overrides.
 */
export type ResourceSpec = { path: string; contentType: string };

/**
 * A PATTERN resource: one field covering a FAMILY of paths, each derived from
 * the proposal's own page path by a rule pinned here (`md_twin` → the page's
 * `.md` twin). The pinning guarantee is unchanged — a caller still cannot pick
 * the key, only the page whose twin it is, and `mdTwinPathReason` rejects
 * anything that isn't a clean root-relative page path.
 */
export type PatternResourceSpec = { pathFor(proposalPath: string): string; contentType: string };

/** Either kind of resource. Discriminated by the presence of `pathFor`. */
export type AnyResourceSpec = ResourceSpec | PatternResourceSpec;

export function isPatternSpec(spec: AnyResourceSpec): spec is PatternResourceSpec {
  return typeof (spec as PatternResourceSpec).pathFor === 'function';
}

/**
 * The spec of a field known to be FIXED-path, for the generators that own one
 * particular file (llms.txt, robots.txt) and need its path before they have a
 * proposal. Throws on a pattern field rather than inventing a path for it.
 */
export function fixedResourceSpec(field: string): ResourceSpec {
  const spec = RESOURCE_FIELDS.get(field);
  if (!spec || isPatternSpec(spec)) throw new Error(`field not a fixed resource: ${field}`);
  return spec;
}

/**
 * The KV path a resource change lands on. Fixed specs answer with their pinned
 * path and ignore the argument; pattern specs derive it from the page path.
 */
export function resourcePathFor(spec: AnyResourceSpec, proposalPath: string): string {
  return isPatternSpec(spec) ? spec.pathFor(proposalPath) : spec.path;
}

/**
 * THE twin-path rule: `/a/b` → `/a/b.md`, `/a/b/` → `/a/b/index.md`. The proxy
 * injector derives the same path in its markdown lane; it is zero-dependency by
 * design and cannot import this module, so it MIRRORS this function (see
 * `twinPath` in injector/src/index.ts) — change one, change the other.
 */
export function mdTwinPath(pagePath: string): string {
  const reason = mdTwinPathReason(pagePath);
  if (reason) throw new Error(`invalid md_twin path: ${reason}`);
  return pagePath.endsWith('/') ? `${pagePath}index.md` : `${pagePath}.md`;
}

/**
 * Why a page path can't carry a markdown twin, or null. A twin key is derived
 * from caller-supplied text, so this is the guard that keeps the derivation
 * inside the site's own page space: root-relative, no traversal, no query or
 * fragment, and not already a `.md` file (whose twin would be `/x.md.md`).
 */
export function mdTwinPathReason(pagePath: string): string | null {
  if (!pagePath) return 'empty path';
  if (!pagePath.startsWith('/')) return 'path must be root-relative (start with "/")';
  if (pagePath.includes('?') || pagePath.includes('#')) return 'path must not contain a query string or fragment';
  if (pagePath.includes('..')) return 'path must not contain ".."';
  if (pagePath.includes('//')) return 'path must not contain an empty segment';
  // A backslash is not a path separator here, but it IS one to a URL parser:
  // new URL('/\\evil.com/x', 'https://site.com') resolves to https://evil.com/x.
  // Anything that publishes a twin eventually turns this path into a URL, so
  // the rule belongs beside the traversal check rather than in each caller.
  if (pagePath.includes('\\')) return 'path must not contain a backslash';
  // eslint-disable-next-line no-control-regex -- control characters in a path
  // are never legitimate and can smuggle line breaks into anything that logs,
  // signs, or requests it.
  if (/[\u0000-\u001f\u007f]/.test(pagePath)) return 'path must not contain control characters';
  if (/\.md$/i.test(pagePath)) return 'path is already a .md file';
  return null;
}

export const RESOURCE_FIELDS = new Map<string, AnyResourceSpec>([
  ['llms_txt', { path: '/llms.txt', contentType: 'text/markdown; charset=utf-8' }],
  ['llms_full_txt', { path: '/llms-full.txt', contentType: 'text/markdown; charset=utf-8' }],
  ['robots_txt', { path: '/robots.txt', contentType: 'text/plain; charset=utf-8' }],
  // Only ever proposed for a site whose OWN sitemap could not serve — the
  // origin-wins gate lives in sitemap.ts (`sitemapProposalBlockedReason`),
  // because it is a question about what the crawl found, not about this keyspace.
  ['sitemap_xml', { path: '/sitemap.xml', contentType: 'application/xml; charset=utf-8' }],
  ['md_twin', { pathFor: mdTwinPath, contentType: 'text/markdown; charset=utf-8' }],
]);

/**
 * Sanity bound on a proposed resource body. Well under KV's 25 MB value limit —
 * the point is that these files are read by answer engines, which truncate long
 * inputs anyway, so a multi-megabyte body is a bug, not a big site.
 */
export const RESOURCE_MAX_CHARS = 100_000;

export function overrideKey(path: string): string {
  return `override:${path === '' ? '/' : path}`;
}

export function resourceKey(path: string): string {
  return `resource:${path === '' ? '/' : path}`;
}

/**
 * The body currently published for a resource, or null when none is (the
 * injector then falls back to whatever the origin serves). Unparseable or
 * body-less JSON reads as "nothing published" rather than throwing, matching
 * readOverride's fail-soft posture.
 */
export async function readResource(deps: Pick<AgentDeps, 'overrides'>, path: string): Promise<string | null> {
  const raw = await deps.overrides.get(resourceKey(path));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { body?: unknown };
    return typeof parsed.body === 'string' ? parsed.body : null;
  } catch {
    return null;
  }
}

/**
 * Publish a resource body to KV and journal it, the resource-side twin of
 * applyOverride. `field` must be a known RESOURCE_FIELDS key; the change row's
 * path is the resolved resource path, so the journal reads the same way as a
 * page change — and a revert can key off the row alone. For a PATTERN field the
 * caller must pass the proposal's page path; the derived twin path is what gets
 * journalled (`/a/b` proposes, `/a/b.md` is the row and the key).
 */
export async function applyResource(
  deps: Pick<AgentDeps, 'db' | 'overrides'>,
  args: { field: string; value: string; source: string; proposalId?: number; path?: string }
): Promise<number> {
  const spec = RESOURCE_FIELDS.get(args.field);
  if (!spec) throw new Error(`field not a resource: ${args.field}`);
  if (isPatternSpec(spec) && !args.path) throw new Error(`field ${args.field} requires a path`);
  const path = resourcePathFor(spec, args.path ?? '');
  // Journal the TRUE prior state — and for a RESOURCE, the only prior state we
  // own is what is live in KV. The proposal's current_value is a snapshot of the
  // ORIGIN's own file, which we never published and must not "restore": the way
  // to give the origin its file back is to delete our key and let it serve
  // again. Journalling the origin snapshot here would make revert PUT a pinned
  // copy of a file we don't control — the origin could have changed twice over,
  // and "revert" would freeze a stale body forever.
  //
  // So: no live value → old_value NULL → revert deletes the key. A live value
  // (a second approval before any revert) IS ours, and revert restores it.
  // Deliberately unlike applyOverride, whose page fields merge into a value the
  // site itself bakes in, and whose snapshot old_value is meaningful.
  const oldValue = await readResource(deps, path);
  await deps.overrides.put(resourceKey(path), JSON.stringify({ contentType: spec.contentType, body: args.value }));

  const now = new Date().toISOString();
  const row = await deps.db.prepare(
    'INSERT INTO changes (applied_at, path, field, old_value, new_value, source, proposal_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  )
    .bind(now, path, args.field, oldValue, args.value, args.source, args.proposalId ?? null)
    .first<{ id: number }>();
  console.log(JSON.stringify({ evt: 'resource_applied', path, field: args.field, source: args.source, bytes: args.value.length }));
  return row?.id ?? 0;
}

export async function readOverride(deps: Pick<AgentDeps, 'overrides'>, path: string): Promise<Record<string, string>> {
  const raw = await deps.overrides.get(overrideKey(path));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function applyOverride(
  deps: Pick<AgentDeps, 'db' | 'overrides'> & Partial<Pick<AgentDeps, 'config'>>,
  args: { path: string; field: string; value: string; oldValue: string | null; source: string; proposalId?: number }
): Promise<number> {
  if (!OVERRIDE_FIELDS.has(args.field)) throw new Error(`field not overridable: ${args.field}`);
  // THE choke point for the title suffix contract — see withTitleSuffix above.
  // The caller hands us the value the reviewer judged (the core); what goes to
  // KV, to the journal's new_value, and to the reader is the full served value.
  const value = storedOverrideValue(args.field, args.value, deps.config?.titleBrandSuffix);
  const current = await readOverride(deps, args.path);
  // Journal the TRUE prior state. The caller's oldValue is the proposal's
  // current_value, captured from a snapshot at proposal-creation — when an
  // override field is already live in KV (two approvals for the same
  // (path, field) between crawls), that live value is what a revert must
  // restore, not the snapshot-era origin value.
  const oldValue = current[args.field] !== undefined ? current[args.field] : args.oldValue;
  current[args.field] = value;
  await deps.overrides.put(overrideKey(args.path), JSON.stringify(current));

  const now = new Date().toISOString();
  const row = await deps.db.prepare(
    'INSERT INTO changes (applied_at, path, field, old_value, new_value, source, proposal_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  )
    .bind(now, args.path, args.field, oldValue, value, args.source, args.proposalId ?? null)
    .first<{ id: number }>();
  console.log(JSON.stringify({ evt: 'override_applied', path: args.path, field: args.field, source: args.source }));
  return row?.id ?? 0;
}

export type RevertResult = { ok: true } | { ok: false; error: string; status: number };

/**
 * Revert an applied change: restore the field's previous value into KV (or drop
 * the override field when there was no previous value, falling back to the site's
 * baked value). Only the LATEST un-reverted change for a (path, field) may be
 * reverted — reverting an older one would silently clobber the newer live value,
 * so it errors instead. Keeps the journal (reverted_at) and source proposal
 * (status → reverted) consistent.
 */
export async function revertChange(deps: Pick<AgentDeps, 'db' | 'overrides'>, changeId: number): Promise<RevertResult> {
  const change = await deps.db.prepare('SELECT id, path, field, old_value, reverted_at FROM changes WHERE id = ?')
    .bind(changeId)
    .first<{ id: number; path: string; field: string; old_value: string | null; reverted_at: string | null }>();
  if (!change) return { ok: false, error: 'change not found', status: 404 };
  if (change.reverted_at) return { ok: false, error: 'change already reverted', status: 409 };

  // Guard: a newer un-reverted change for the same (path, field) holds the live
  // value. Reverting THIS (older) one would delete/overwrite that newer value.
  const latest = await deps.db.prepare(
    'SELECT MAX(id) AS id FROM changes WHERE path = ? AND field = ? AND reverted_at IS NULL'
  )
    .bind(change.path, change.field)
    .first<{ id: number | null }>();
  if (latest?.id != null && latest.id !== change.id) {
    return {
      ok: false,
      error: `a newer un-reverted change (#${latest.id}) exists for ${change.path} ${change.field} — revert that first`,
      status: 409,
    };
  }

  const spec = RESOURCE_FIELDS.get(change.field);
  if (spec) {
    // Resource change: the whole file is the value, so restoring the prior body
    // means rewriting the key — or deleting it when nothing was published
    // before, letting the origin's own file surface again. The row's path IS
    // the resolved resource path (applyResource journals it that way), so a
    // pattern field needs no re-derivation here.
    if (change.old_value != null && change.old_value !== '') {
      await deps.overrides.put(resourceKey(change.path), JSON.stringify({ contentType: spec.contentType, body: change.old_value }));
    } else {
      await deps.overrides.delete(resourceKey(change.path));
    }
  } else {
    const current = await readOverride(deps, change.path);
    // Restore the prior value; only drop the field when there was no prior value
    // (so the page falls back to the value baked into the site).
    if (change.old_value != null && change.old_value !== '') {
      current[change.field] = change.old_value;
    } else {
      delete current[change.field];
    }
    if (Object.keys(current).length === 0) {
      await deps.overrides.delete(overrideKey(change.path));
    } else {
      await deps.overrides.put(overrideKey(change.path), JSON.stringify(current));
    }
  }
  await deps.db.prepare('UPDATE changes SET reverted_at = ? WHERE id = ?').bind(new Date().toISOString(), change.id).run();
  // Retire the source proposal so the page becomes proposable again — an
  // 'approved' proposal would otherwise block re-proposal forever.
  await deps.db.prepare(
    "UPDATE proposals SET status = 'reverted' WHERE status = 'approved' AND id = (SELECT proposal_id FROM changes WHERE id = ?)"
  )
    .bind(change.id)
    .run();
  console.log(
    JSON.stringify({
      evt: 'override_reverted',
      changeId: change.id,
      path: change.path,
      field: change.field,
      restored: change.old_value != null && change.old_value !== '',
    })
  );
  return { ok: true };
}
