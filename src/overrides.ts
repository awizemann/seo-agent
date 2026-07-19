/**
 * KV override plumbing. Overrides live at `override:<path>` as a JSON object
 * of field → value (fields: description, title). The site Worker's edge SEO
 * layer merges them over its computed meta on every page request, so an
 * approved change is live within the KV cache TTL — no deploy. Every apply
 * and revert lands in the `changes` journal.
 */

const OVERRIDE_FIELDS = new Set(['description', 'title']);

export function overrideKey(path: string): string {
  return `override:${path === '' ? '/' : path}`;
}

export async function readOverride(env: Env, path: string): Promise<Record<string, string>> {
  const raw = await env.OVERRIDES.get(overrideKey(path));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function applyOverride(
  env: Env,
  args: { path: string; field: string; value: string; oldValue: string | null; source: string; proposalId?: number }
): Promise<number> {
  if (!OVERRIDE_FIELDS.has(args.field)) throw new Error(`field not overridable: ${args.field}`);
  const current = await readOverride(env, args.path);
  // Journal the TRUE prior state. The caller's oldValue is the proposal's
  // current_value, captured from a snapshot at proposal-creation — when an
  // override field is already live in KV (two approvals for the same
  // (path, field) between crawls), that live value is what a revert must
  // restore, not the snapshot-era origin value.
  const oldValue = current[args.field] !== undefined ? current[args.field] : args.oldValue;
  current[args.field] = args.value;
  await env.OVERRIDES.put(overrideKey(args.path), JSON.stringify(current));

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
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
export async function revertChange(env: Env, changeId: number): Promise<RevertResult> {
  const change = await env.DB.prepare('SELECT id, path, field, old_value, reverted_at FROM changes WHERE id = ?')
    .bind(changeId)
    .first<{ id: number; path: string; field: string; old_value: string | null; reverted_at: string | null }>();
  if (!change) return { ok: false, error: 'change not found', status: 404 };
  if (change.reverted_at) return { ok: false, error: 'change already reverted', status: 409 };

  // Guard: a newer un-reverted change for the same (path, field) holds the live
  // value. Reverting THIS (older) one would delete/overwrite that newer value.
  const latest = await env.DB.prepare(
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

  const current = await readOverride(env, change.path);
  // Restore the prior value; only drop the field when there was no prior value
  // (so the page falls back to the value baked into the site).
  if (change.old_value != null && change.old_value !== '') {
    current[change.field] = change.old_value;
  } else {
    delete current[change.field];
  }
  if (Object.keys(current).length === 0) {
    await env.OVERRIDES.delete(overrideKey(change.path));
  } else {
    await env.OVERRIDES.put(overrideKey(change.path), JSON.stringify(current));
  }
  await env.DB.prepare('UPDATE changes SET reverted_at = ? WHERE id = ?').bind(new Date().toISOString(), change.id).run();
  // Retire the source proposal so the page becomes proposable again — an
  // 'approved' proposal would otherwise block re-proposal forever.
  await env.DB.prepare(
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
