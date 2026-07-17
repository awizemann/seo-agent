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
  current[args.field] = args.value;
  await env.OVERRIDES.put(overrideKey(args.path), JSON.stringify(current));

  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    'INSERT INTO changes (applied_at, path, field, old_value, new_value, source, proposal_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
  )
    .bind(now, args.path, args.field, args.oldValue, args.value, args.source, args.proposalId ?? null)
    .first<{ id: number }>();
  console.log(JSON.stringify({ evt: 'override_applied', path: args.path, field: args.field, source: args.source }));
  return row?.id ?? 0;
}

/** Remove the change's field from the live override (falling back to the value baked in the site). */
export async function revertChange(env: Env, changeId: number): Promise<boolean> {
  const change = await env.DB.prepare('SELECT id, path, field, reverted_at FROM changes WHERE id = ?')
    .bind(changeId)
    .first<{ id: number; path: string; field: string; reverted_at: string | null }>();
  if (!change || change.reverted_at) return false;

  const current = await readOverride(env, change.path);
  delete current[change.field];
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
  console.log(JSON.stringify({ evt: 'override_reverted', changeId: change.id, path: change.path, field: change.field }));
  return true;
}
