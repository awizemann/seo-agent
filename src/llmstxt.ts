/**
 * /llms.txt generation — the site's index for answer engines.
 *
 * The AEO checks (aeo.ts) can only tell you the file is missing or a soft 404;
 * this module produces one, from the crawl the agent already has. The content
 * is derived, never invented: every entry is a page the last successful crawl
 * actually fetched with a 200, so a link in llms.txt can't point at something
 * the site doesn't serve.
 *
 * Publishing goes through the ordinary review lane — a proposal on the
 * `llms_txt` field, approved by a human, applied to KV as a resource override
 * (see RESOURCE_FIELDS in overrides.ts) and revertable from the same journal
 * as any meta change. Nothing here writes to KV directly.
 */

import { createProposal, ApiError } from './actions.js';
import { RESOURCE_FIELDS, readResource } from './overrides.js';
import { findBannedTerm } from './config.js';
import type { SiteConfig } from './config.js';
import type { AgentDeps } from './deps.js';

/** The page fields buildLlmsTxt needs — a subset of a page_snapshots row. */
export type LlmsTxtPage = {
  path: string;
  title: string | null;
  description: string | null;
  /** SQLite stores this as 0/1; a boolean works too. */
  noindex: number | boolean | null;
  status: number;
  error?: string | null;
};

// The list is an orientation aid for an answer engine, not a sitemap: past a
// couple hundred links it stops being read and starts being skimmed. Sites
// bigger than this get their article pages first (see the ordering below).
export const LLMS_TXT_MAX_ENTRIES = 200;

// Per-entry text bounds. Snapshot title/description are whatever the page
// delivered — unbounded, and a page CAN ship a multi-kilobyte description. Two
// reasons to clip: a runaway line is noise to the reader, and 200 unbounded
// entries could push the body past the resource size cap, turning a generated
// file into a validation error at proposal time. Generous vs. the SEO rules'
// own 60/160 bounds, so normal copy is never touched.
const MAX_LABEL_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 200;

/** The config fields the generator reads. */
export type LlmsTxtConfig = Pick<SiteConfig, 'siteUrl' | 'siteName' | 'siteDescription' | 'articlePathPrefix'>;

/**
 * Flatten a snapshot string into one line of markdown. Snapshots carry whatever
 * the page delivered, which can include newlines (a wrapped <meta> attribute)
 * and control characters — either would break the single-line list item this
 * lands in. Collapses all whitespace runs to single spaces and trims.
 */
const oneLine = (s: string, max: number): string =>
  s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim(); // the slice can land on a space it just normalized

/**
 * Escape the characters that would break a markdown link's text: an unescaped
 * `]` closes the label early, leaving the URL as visible junk. Backslash goes
 * first so it can't double-escape what the others add.
 */
const escapeLinkText = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');

/**
 * Build the /llms.txt body. Pure — feed it page rows and a site profile.
 *
 * Excluded: noindexed pages (the site asked search engines not to index them;
 * an AI index is no different), non-200 pages, and rows that errored — an
 * llms.txt full of dead links is worse than no llms.txt at all.
 *
 * Ordering: article pages first (the content an engine is looking for), then
 * everything else, each group keeping the caller's order so a stable input
 * gives a stable file — a churning body would produce a new proposal every run.
 */
export function buildLlmsTxt(pages: LlmsTxtPage[], config: LlmsTxtConfig): string {
  // Trailing slashes on SITE_URL are common and would yield "https://x.com//p".
  const base = config.siteUrl.replace(/\/+$/, '');
  const prefix = config.articlePathPrefix;

  // Dedupe by path (first wins): two sitemap entries differing only in query
  // or trailing slash snapshot to one path, and a doubled link reads as an
  // error to whatever is parsing this.
  const seen = new Set<string>();
  const usable: LlmsTxtPage[] = [];
  for (const p of pages) {
    if (p.status !== 200 || p.noindex || p.error) continue;
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    usable.push(p);
  }
  const articles = prefix ? usable.filter((p) => p.path.startsWith(prefix)) : [];
  const rest = prefix ? usable.filter((p) => !p.path.startsWith(prefix)) : usable;

  const entries = [...articles, ...rest].slice(0, LLMS_TXT_MAX_ENTRIES).map((p) => {
    // A page that delivered no <title> still deserves a link; its path is the
    // most honest label available. Escape AFTER clipping, so a truncation can
    // never cut a backslash away from what it escapes.
    const label = escapeLinkText(oneLine(p.title ?? '', MAX_LABEL_CHARS)) || p.path;
    const description = oneLine(p.description ?? '', MAX_DESCRIPTION_CHARS);
    return `- [${label}](${base}${p.path})${description ? `: ${description}` : ''}`;
  });

  const siteDescription = oneLine(config.siteDescription ?? '', MAX_DESCRIPTION_CHARS);
  const lines = [`# ${oneLine(config.siteName, MAX_LABEL_CHARS)}`];
  if (siteDescription) lines.push(`> ${siteDescription}`);
  lines.push('', '## Pages', ...entries);
  return lines.join('\n') + '\n';
}

/**
 * Generate the current /llms.txt body from the latest SUCCESSFUL crawl (ok = 1
 * — a failed or half-finished run would publish a truncated index). Returns the
 * body plus the entry count, which is what tells a caller whether there is
 * anything worth publishing.
 */
export async function generateLlmsTxt(
  deps: Pick<AgentDeps, 'db' | 'config'>
): Promise<{ body: string; entries: number; runId: number | null }> {
  const run = await deps.db.prepare('SELECT id FROM crawl_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1').first<{ id: number }>();
  if (!run) return { body: buildLlmsTxt([], deps.config), entries: 0, runId: null };
  const rows = (
    await deps.db.prepare('SELECT path, title, description, noindex, status, error FROM page_snapshots WHERE run_id = ? ORDER BY path')
      .bind(run.id)
      .all<LlmsTxtPage>()
  ).results;
  const body = buildLlmsTxt(rows, deps.config);
  // The banned-terms gate, applied to DERIVED content. Unlike a draft, nothing
  // here was written by a model, so there is no retry that could fix it: every
  // word in the body came off a page the site itself serves. The honest move is
  // to fail loudly and name the term, so the operator knows to fix the source
  // page (or drop the term) — silently stripping it would publish an index whose
  // labels no longer match the pages they link to.
  const banned = findBannedTerm(body, deps.config.bannedTerms);
  if (banned) {
    throw new ApiError(
      `generated llms.txt contains banned term "${banned}" (from your page content) — fix the source page or remove the term`,
      409
    );
  }
  // Count entries off the rendered body rather than re-applying the filters
  // here — buildLlmsTxt stays the single place that decides what is listed, and
  // its sanitizing means only a real entry can start a line with "- [".
  const entries = body.split('\n').filter((l) => l.startsWith('- [')).length;
  return { body, entries, runId: run.id };
}

/**
 * Propose the generated /llms.txt for approval. current_value is whatever body
 * is live in KV right now (null on the first ever proposal), so the reviewer
 * sees a real diff and a later revert has something to restore.
 */
export async function createLlmsTxtProposal(deps: Pick<AgentDeps, 'db' | 'config' | 'overrides'>) {
  const spec = RESOURCE_FIELDS.get('llms_txt')!;
  const { body, entries } = await generateLlmsTxt(deps);
  // Publishing a header with an empty page list would tell answer engines the
  // site has nothing — strictly worse than serving no file.
  if (entries < 1) throw new ApiError('no crawled pages to index — run a crawl first', 409);
  const current = await readResource(deps, spec.path);
  console.log(JSON.stringify({ evt: 'llmstxt_proposed', entries, bytes: body.length }));
  return createProposal(
    deps,
    { path: spec.path, field: 'llms_txt', value: body, currentValue: current, rationale: `generated from the latest crawl (${entries} pages)` },
    () => null // unused: resource fields don't run the description validator
  );
}
