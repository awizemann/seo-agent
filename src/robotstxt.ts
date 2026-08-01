/**
 * /robots.txt AI-crawler policy — making an implicit allow explicit.
 *
 * The AEO checks (aeo.ts) can tell you robots.txt is unreachable
 * (`robots_txt_unreachable`) or names no AI crawler at all
 * (`robots_no_ai_policy`); this module produces the fix. It is deliberately the
 * most conservative thing that resolves those findings: an APPEND, never a
 * rewrite. robots.txt is the one file where a bad edit takes the whole site out
 * of search, so the generator's contract is that every byte the origin already
 * serves survives verbatim — the only new bytes are a clearly delimited block at
 * the end (or, on regeneration, in place of the block we wrote last time).
 *
 * Removing an existing `Disallow` is explicitly NOT in scope (that's the
 * `robots_blocks_ai_bot` finding, a different and much riskier fix): a bot the
 * file already names, allow or deny, is left exactly as the owner wrote it.
 *
 * Publishing goes through the ordinary review lane — a proposal on the
 * `robots_txt` field, approved by a human, applied to KV as a resource override
 * (see RESOURCE_FIELDS in overrides.ts) and revertable from the same journal as
 * any meta change. Nothing here writes to KV directly.
 */

import { createProposal, ApiError } from './actions.js';
import { RESOURCE_FIELDS } from './overrides.js';
import { ANSWER_ENGINE_BOTS, classifyTextResource, parseRobots, robotsDecision, type RobotsGroup } from './aeo.js';
import { VERSION } from './version.js';
import type { AgentDeps } from './deps.js';

/**
 * The managed block's fences. They are ordinary robots.txt comments, so a parser
 * that has never heard of us ignores them; for us they are the handle that makes
 * regeneration idempotent — the block is REPLACED in place rather than appended
 * a second time.
 */
export const AI_POLICY_BEGIN = '# --- AI crawler policy (managed by seo-agent) ---';
export const AI_POLICY_END = '# --- end AI crawler policy ---';

const FETCH_TIMEOUT_MS = 15_000;
const AGENT_UA = `seo-agent/${VERSION} (aeo-audit; +https://github.com/awizemann/seo-agent)`;

/** A marker line, ignoring indentation and the CR of a CRLF file. */
const isMarker = (line: string, marker: string): boolean => line.replace(/\r$/, '').trim() === marker;

/**
 * Byte ranges (as line indices, end inclusive) of every managed block in the
 * file. A stray BEGIN with no END claims nothing — we would rather leave a
 * malformed marker alone than swallow the rest of the file with it.
 */
function managedRanges(lines: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isMarker(lines[i], AI_POLICY_BEGIN)) continue;
    const end = lines.findIndex((l, j) => j > i && isMarker(l, AI_POLICY_END));
    if (end === -1) break;
    out.push([i, end]);
    i = end;
  }
  return out;
}

/**
 * The `User-agent: *` rules a newly added bot group must carry. REP evaluates
 * the MOST SPECIFIC matching group exclusively: the moment we write an explicit
 * `User-agent: Googlebot` group, every `*` rule stops applying to Googlebot. So
 * a bare "User-agent: X / Allow: /" would not be an addition at all — it would
 * silently lift the site's own Disallows for that bot. Copying the `*` rules in
 * keeps the bot's effective policy byte-for-byte what it was, with `Allow: /`
 * only restating the fallback that was already in force (longest-match means a
 * copied `Disallow: /admin/` still wins over it).
 */
function starRules(groups: RobotsGroup[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    if (!g.agents.includes('*')) continue;
    for (const a of g.allows) if (a && !seen.has(`a${a}`)) (seen.add(`a${a}`), out.push(`Allow: ${a}`));
    // An empty "Disallow:" means allow-all — nothing to carry over.
    for (const d of g.disallows) if (d && !seen.has(`d${d}`)) (seen.add(`d${d}`), out.push(`Disallow: ${d}`));
  }
  return out;
}

/**
 * Append (or regenerate) the managed AI-crawler policy block. PURE, and
 * append-only: no existing line is reordered, rewritten or removed, so the
 * result always has the input as its prefix unless a managed block from a
 * previous run is being replaced in place.
 *
 * A bot is added only when the file is silent about it AND the file's current
 * answer for it is "allow". Both exclusions serve the same property — we never
 * contradict a policy the owner already expressed:
 *   - named already (allow OR deny, case-insensitively): their line stands;
 *   - blocked by the `*` group: adding `Allow: /` would flip a deny to an allow.
 *
 * Returns the input unchanged when there is nothing to add, which is how the
 * caller detects "already covered".
 */
export function appendAiPolicy(currentBody: string, bots: string[]): string {
  // split('\n') then join('\n') is byte-identity, CRLF and all: each line keeps
  // its own trailing '\r', so a CRLF file stays CRLF and an LF file stays LF.
  const lines = currentBody.split('\n');
  const ranges = managedRanges(lines);

  // Analyse the file as it would read WITHOUT our block: the bots we wrote last
  // time must not count as "already named", or regeneration would empty itself.
  // The BOM (if any) is stripped for parsing only — it stays in the output.
  const outside = lines
    .filter((_, i) => !ranges.some(([s, e]) => i >= s && i <= e))
    .join('\n')
    .replace(/^﻿/, '');
  const groups = parseRobots(outside);
  const named = new Set(groups.flatMap((g) => g.agents.map((a) => a.toLowerCase())));
  const inherited = starRules(groups);

  const add = bots.filter((b) => !named.has(b.toLowerCase()) && robotsDecision(groups, b, '/') === 'allow');

  const eol = /\r\n/.test(currentBody) ? '\r' : '';
  const block: string[] = [];
  if (add.length > 0) {
    block.push(AI_POLICY_BEGIN);
    if (inherited.length > 0) {
      block.push('# Each group repeats your existing "User-agent: *" rules, because an');
      block.push('# explicit group replaces (never merges with) the * group for that bot.');
    }
    for (const bot of add) {
      block.push('', `User-agent: ${bot}`, 'Allow: /', ...inherited);
    }
    block.push(AI_POLICY_END);
  }
  const fenced = block.map((l) => l + eol);

  if (ranges.length > 0) {
    // Regeneration: the first block is replaced where it stands, and any further
    // block (a hand-pasted duplicate, or an older copy) collapses into it — the
    // only lines this branch ever removes are ones we wrote.
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const range = ranges.find(([s]) => s === i);
      if (!range) {
        out.push(lines[i]);
        continue;
      }
      if (range === ranges[0]) out.push(...fenced);
      i = range[1];
    }
    return out.join('\n');
  }

  if (add.length === 0) return currentBody;
  // Nothing but whitespace to preserve: emit the block as the whole file.
  if (currentBody.trim() === '') return fenced.join('\n') + '\n';
  // Otherwise append, keeping the file's trailing-newline discipline: a body
  // ending in '\n' has '' as its last split element, so inserting BEFORE it
  // keeps the final newline; a body without one stays without one.
  const tail = lines[lines.length - 1] === '' ? 1 : 0;
  const head = lines.slice(0, lines.length - tail);
  // One blank separator line, unless the file already ends in one.
  const sep = head[head.length - 1]?.replace(/\r$/, '').trim() === '' ? [] : [eol];
  return [...head, ...sep, ...fenced, ...lines.slice(lines.length - tail)].join('\n');
}

type FetchedRobots = { status: number; contentType: string; body: string; error: string | null };

async function fetchRobots(url: string): Promise<FetchedRobots> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': AGENT_UA, accept: '*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    return { status: res.status, contentType: res.headers.get('content-type') || '', body: await res.text(), error: null };
  } catch (err) {
    return { status: 0, contentType: '', body: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Propose an AI-crawler policy for /robots.txt.
 *
 * Two shapes, decided by the same classifier the AEO check uses so the fix can
 * never disagree with the finding that asked for it:
 *   - a real file (200, not an HTML shell) → append to exactly those bytes, and
 *     journal them as current_value so the reviewer sees a true diff and a
 *     revert has something to restore;
 *   - absent, an HTML soft-404, or unreachable → synthesize a minimal file.
 *     Nothing is being replaced, so there is nothing to preserve; current_value
 *     is null.
 *
 * The origin is re-fetched HERE rather than reusing the crawl's copy: the body
 * we append to is the body a reviewer is about to publish over, and a stale one
 * would silently drop whatever the owner changed since the last run.
 */
export async function generateRobotsProposal(deps: Pick<AgentDeps, 'db' | 'config' | 'overrides'>) {
  const spec = RESOURCE_FIELDS.get('robots_txt')!;
  const origin = new URL(deps.config.siteUrl).origin;
  const fetched = await fetchRobots(`${origin}${spec.path}`);
  const state = fetched.error ? 'error' : classifyTextResource(fetched.status, fetched.contentType, fetched.body);

  // A misconfigured origin can serve a perfectly real robots.txt as text/html,
  // which classifyTextResource calls a soft 404. Synthesizing over that would
  // DELETE the owner's rules — the one thing this module promises never to do.
  // So a soft-404 whose body is plainly a rules file (directives, no markup) is
  // appended to like any other; only actual HTML gets replaced.
  const looksLikeRules =
    !/^\s*(?:<!doctype|<html)/i.test(fetched.body) && /^\s*(?:user-agent|disallow|allow|sitemap)\s*:/im.test(fetched.body);

  let currentValue: string | null = null;
  let body: string;
  if (state === 'ok' || (state === 'soft_404' && looksLikeRules)) {
    currentValue = fetched.body;
    body = appendAiPolicy(fetched.body, ANSWER_ENGINE_BOTS);
    if (body === fetched.body) {
      throw new ApiError('robots.txt already names every AI crawler — nothing to add', 409);
    }
  } else {
    // Minimal synthesized file: the allow-all default crawlers already assume,
    // made explicit, plus the sitemap pointer a from-scratch robots.txt should
    // carry. Sitemap is a non-group field, so it goes after the managed block.
    body = appendAiPolicy('User-agent: *\nAllow: /\n', ANSWER_ENGINE_BOTS) + `\nSitemap: ${origin}/sitemap.xml\n`;
  }

  console.log(JSON.stringify({ evt: 'robotstxt_proposed', state, bytes: body.length }));
  return createProposal(
    deps,
    { path: spec.path, field: 'robots_txt', value: body, currentValue, rationale: 'ai-policy append' },
    () => null // unused: resource fields don't run the description validator
  );
}
