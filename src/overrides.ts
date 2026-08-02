/**
 * KV override plumbing. Overrides live at `override:<path>` as a JSON object
 * of field → value (fields: description, title). The site Worker's edge SEO
 * layer merges them over its computed meta on every page request, so an
 * approved change is live within the KV cache TTL — no deploy. Every apply
 * and revert lands in the `changes` journal.
 *
 * Site-level FILES (/llms.txt, /robots.txt) ride the same journal but a different
 * key space — `resource:<path>`, holding the whole file — see RESOURCE_FIELDS.
 */

import type { AgentDeps } from './deps.js';

const OVERRIDE_FIELDS = new Set(['description', 'title']);

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
  if (/\.md$/i.test(pagePath)) return 'path is already a .md file';
  return null;
}

export const RESOURCE_FIELDS = new Map<string, AnyResourceSpec>([
  ['llms_txt', { path: '/llms.txt', contentType: 'text/markdown; charset=utf-8' }],
  ['llms_full_txt', { path: '/llms-full.txt', contentType: 'text/markdown; charset=utf-8' }],
  ['robots_txt', { path: '/robots.txt', contentType: 'text/plain; charset=utf-8' }],
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
  deps: Pick<AgentDeps, 'db' | 'overrides'>,
  args: { path: string; field: string; value: string; oldValue: string | null; source: string; proposalId?: number }
): Promise<number> {
  if (!OVERRIDE_FIELDS.has(args.field)) throw new Error(`field not overridable: ${args.field}`);
  const current = await readOverride(deps, args.path);
  // Journal the TRUE prior state. The caller's oldValue is the proposal's
  // current_value, captured from a snapshot at proposal-creation — when an
  // override field is already live in KV (two approvals for the same
  // (path, field) between crawls), that live value is what a revert must
  // restore, not the snapshot-era origin value.
  const oldValue = current[args.field] !== undefined ? current[args.field] : args.oldValue;
  current[args.field] = args.value;
  await deps.overrides.put(overrideKey(args.path), JSON.stringify(current));

  const now = new Date().toISOString();
  const row = await deps.db.prepare(
    'INSERT INTO changes (applied_at, path, field, old_value, new_value, source, proposal_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  )
    .bind(now, args.path, args.field, oldValue, args.value, args.source, args.proposalId ?? null)
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
