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
 * No banned-terms check here, unlike llms.txt. BANNED_TERMS is a vocabulary
 * rule for PROSE the agent writes or assembles; robots.txt is neither. Its
 * content is directives and user-agent tokens — bot and vendor names the owner
 * does not choose and cannot rewrite — plus whatever the origin already served,
 * which this module is contractually forbidden to alter. Banning a word that
 * happens to appear in a crawler's name would block the one fix that resolves
 * `robots_no_ai_policy`, for no editorial gain.
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
import { RESOURCE_FIELDS, RESOURCE_MAX_CHARS } from './overrides.js';
import { ANSWER_ENGINE_BOTS, classifyTextResource, parseRobots, robotsDecision } from './aeo.js';
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
 * Fields that belong to the FILE, not to a group. Copying `Sitemap:` into a
 * per-bot group would be meaningless (it is already global) and duplicate
 * noise; `Host:` is the same shape of non-group directive.
 */
const NON_GROUP_FIELDS = new Set(['sitemap', 'host']);

/** `Allow: /` (or `Allow: /*`) — the rule every generated group states itself. */
const isAllowRoot = (line: string): boolean => /^allow\s*:\s*\/\*?$/i.test(line);

/**
 * The `User-agent: *` directives a newly added bot group must carry. REP
 * evaluates the MOST SPECIFIC matching group exclusively: the moment we write an
 * explicit `User-agent: Googlebot` group, every `*` rule stops applying to
 * Googlebot. So a bare "User-agent: X / Allow: /" would not be an addition at
 * all — it would silently lift the site's own Disallows for that bot. Copying
 * the `*` rules in keeps the bot's effective policy byte-for-byte what it was,
 * with `Allow: /` only restating the fallback that was already in force
 * (longest-match means a copied `Disallow: /admin/` still wins over it).
 *
 * Read off the RAW text rather than parseRobots' groups, because the parser
 * keeps only Allow/Disallow. Anything else a `*` group carries — `Crawl-delay`,
 * `Clean-param`, a directive neither we nor the parser has heard of — is
 * group-level too, and dropping it would quietly change policy for exactly the
 * bots we are making explicit. So every group-level line is carried verbatim,
 * recognized or not.
 */
function starDirectives(txt: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let inStar = false;
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      // A User-agent line after RULES opens a new group; after another
      // User-agent line it only adds an alias to the group being opened.
      if (!lastWasAgent) inStar = false;
      if (value === '*') inStar = true;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!inStar || NON_GROUP_FIELDS.has(field)) continue;
    // An empty "Disallow:" means allow-all — nothing to carry over.
    if ((field === 'disallow' || field === 'allow') && value === '') continue;
    const key = `${field}:${value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${m[1]}: ${value}`);
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
  const tokens = groups.flatMap((g) => g.agents.map((a) => a.toLowerCase())).filter((a) => a !== '' && a !== '*');
  const inherited = starDirectives(outside);

  // Crawlers match a user-agent token by PREFIX, not equality: a group headed
  // `User-agent: ChatGPT` is the policy ChatGPT-User obeys. Treating that as
  // "not named" and appending our own ChatGPT-User group would override the
  // owner's line for that bot — the one thing this module must never do.
  const named = (bot: string): boolean => {
    const b = bot.toLowerCase();
    return tokens.some((t) => b.startsWith(t));
  };

  const add = bots.filter((b) => !named(b) && robotsDecision(groups, b, '/') === 'allow');

  const eol = /\r\n/.test(currentBody) ? '\r' : '';
  // `Allow: /` is stated by every generated group, so an inherited copy of it
  // would be a duplicate line; and when it is ALL the * group has to give, the
  // groups repeat nothing worth explaining — drop the explanatory comment too.
  const extras = inherited.filter((l) => !isAllowRoot(l));
  const rules = ['Allow: /', ...extras];
  const block: string[] = [];
  if (add.length > 0) {
    block.push(AI_POLICY_BEGIN);
    if (extras.length > 0) {
      block.push('# Each group repeats your existing "User-agent: *" rules, because an');
      block.push('# explicit group replaces (never merges with) the * group for that bot.');
    }
    for (const bot of add) {
      block.push('', `User-agent: ${bot}`, ...rules);
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

/**
 * Header that tells our own injector to skip resource-override serving and
 * proxy the origin instead. The generator MUST append to the origin's bytes:
 * a fetch that lands on our own published override would append to the file we
 * published last time, so the origin's edits since would silently vanish from
 * the proposal (and from robots.txt, once approved).
 */
export const BYPASS_HEADER = 'x-seo-agent-bypass';
export const BYPASS_RESOURCE = 'resource';

/**
 * A retry UA for origins that answer our crawler with a 403. Bot-management
 * rules routinely block anything that doesn't look like a browser, and robots.txt
 * is public either way — this is about reading a file the whole world can read,
 * not about evading a policy.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function fetchRobots(url: string, userAgent: string): Promise<FetchedRobots> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': userAgent, accept: '*/*', [BYPASS_HEADER]: BYPASS_RESOURCE },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    // Bound the body BEFORE anything else touches it: a multi-megabyte
    // "robots.txt" (a mislabelled dump, a proxy looping) would otherwise be
    // parsed, diffed and rendered on its way to failing createProposal's size
    // check anyway. Fail here, where the message can name the actual size.
    const text = await res.text();
    if (text.length > RESOURCE_MAX_CHARS) {
      throw new ApiError(`your robots.txt is too large to manage (${text.length} chars, max ${RESOURCE_MAX_CHARS})`, 400);
    }
    return { status: res.status, contentType: res.headers.get('content-type') || '', body: text, error: null };
  } catch (err) {
    if (err instanceof ApiError) throw err; // the size bound is a verdict, not a fetch failure
    return { status: 0, contentType: '', body: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A misconfigured origin can serve a perfectly real robots.txt as text/html,
 * which classifyTextResource calls a soft 404. Synthesizing over that would
 * DELETE the owner's rules — the one thing this module promises never to do. So
 * a soft-404 whose body is plainly a rules file (directives, no markup) is
 * appended to like any other; only actual HTML gets replaced.
 */
const looksLikeRules = (body: string): boolean =>
  !/^\s*(?:<!doctype|<html)/i.test(body) && /^\s*(?:user-agent|disallow|allow|sitemap)\s*:/im.test(body);

/** Does this URL actually exist? One HEAD, and any failure reads as "no". */
async function headOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'user-agent': AGENT_UA, accept: '*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    return res.status === 200;
  } catch {
    return false;
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
 *   - absent (404/410) or an HTML soft-404 → synthesize a minimal file. Nothing
 *     is being replaced, so there is nothing to preserve; current_value is null.
 *   - UNREADABLE (403/5xx/network) → refuse, loudly. This is the case the fix
 *     must not paper over: a 403 does not mean "no robots.txt", it means we
 *     could not see one, and synthesizing over a file we failed to read would
 *     publish a policy that silently deletes rules we never saw.
 *
 * The origin is re-fetched HERE rather than reusing the crawl's copy: the body
 * we append to is the body a reviewer is about to publish over, and a stale one
 * would silently drop whatever the owner changed since the last run.
 */
export async function generateRobotsProposal(deps: Pick<AgentDeps, 'db' | 'config' | 'overrides'>) {
  const spec = RESOURCE_FIELDS.get('robots_txt')!;
  const origin = new URL(deps.config.siteUrl).origin;
  const url = `${origin}${spec.path}`;
  const classify = (f: FetchedRobots) => (f.error ? 'error' : classifyTextResource(f.status, f.contentType, f.body));

  let fetched = await fetchRobots(url, AGENT_UA);
  let state = classify(fetched);
  if (state === 'error') {
    // One retry as a browser. The overwhelmingly common cause of a 403 here is
    // bot management refusing an unfamiliar UA, and a public file we're allowed
    // to read is worth one second attempt before telling the owner to go fix
    // their edge. A retry that comes back as an HTML shell is a challenge/login
    // page, NOT a soft 404 — treating it as one would synthesize over a file we
    // still haven't read, so it stays an error.
    const retried = await fetchRobots(url, BROWSER_UA);
    const retriedState = classify(retried);
    if (retriedState === 'ok' || retriedState === 'missing' || (retriedState === 'soft_404' && looksLikeRules(retried.body))) {
      fetched = retried;
      state = retriedState;
    } else {
      const what = retried.error || retried.status === 0 ? 'network error' : `HTTP ${retried.status}`;
      throw new ApiError(
        `we couldn't read your robots.txt (${what}) — fix access (it may be blocking our crawler) and try again.`,
        409
      );
    }
  }

  let currentValue: string | null = null;
  let body: string;
  if (state === 'ok' || (state === 'soft_404' && looksLikeRules(fetched.body))) {
    currentValue = fetched.body;
    body = appendAiPolicy(fetched.body, ANSWER_ENGINE_BOTS);
    if (body === fetched.body) {
      throw new ApiError('robots.txt already names every AI crawler — nothing to add', 409);
    }
  } else {
    // Minimal synthesized file: the allow-all default crawlers already assume,
    // made explicit, plus the sitemap pointer a from-scratch robots.txt should
    // carry. Sitemap is a non-group field, so it goes after the managed block —
    // and only when the sitemap is actually THERE. A `Sitemap:` line pointing at
    // a 404 is a broken promise to every crawler that reads it, and we are
    // already doing network I/O here, so one HEAD settles it.
    body = appendAiPolicy('User-agent: *\nAllow: /\n', ANSWER_ENGINE_BOTS);
    const sitemap = `${origin}/sitemap.xml`;
    if (await headOk(sitemap)) body += `\nSitemap: ${sitemap}\n`;
  }

  console.log(JSON.stringify({ evt: 'robotstxt_proposed', state, bytes: body.length }));
  return createProposal(
    deps,
    { path: spec.path, field: 'robots_txt', value: body, currentValue, rationale: 'ai-policy append' },
    () => null // unused: resource fields don't run the description validator
  );
}
