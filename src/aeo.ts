/**
 * AEO / GEO checks — is the site readable, allowed, and citable for AI answer
 * engines (ChatGPT, Claude, Perplexity, Google AI Overviews, Copilot)?
 *
 * Three check families, all emitting standard findings through the same
 * (path, rule) open/auto-resolve lifecycle as rules.ts:
 *
 *   1. Ingestion surfaces — /llms.txt (and /llms-full.txt) exist and are real
 *      plain-text files. A catch-all that answers 200 with the HTML shell is a
 *      "soft 404" that actively misleads AI agents — worse than a clean 404.
 *   2. Crawl policy — robots.txt is reachable and does not block answer-engine
 *      crawlers. Blocking TRAINING bots is a legitimate owner choice with no
 *      citation cost; blocking OAI-SearchBot / PerplexityBot / Claude-SearchBot
 *      (or Googlebot/Bingbot, which feed AI Overviews and Copilot) silently
 *      removes the site from AI answers.
 *   3. AI deliverability sampling — refetch a few content pages with an AI-bot
 *      user agent and check they (a) aren't UA-blocked by a WAF/CDN rule and
 *      (b) serve actual visible body text. AI crawlers and user-fetchers do NOT
 *      execute JavaScript: a CSR SPA serving an empty shell is invisible to
 *      them at both index and answer time, however good its <head> is. Full
 *      text in Article JSON-LD (`articleBody`) counts as readable content.
 *
 * Site-level findings use the resource's own path (/llms.txt, /robots.txt).
 * A transient fetch failure emits `aeo_check_error` instead of guessing — the
 * trade-off is that a resource that can't be checked this run won't re-trigger
 * its underlying finding, so a still-open one auto-resolves and re-opens on the
 * next successful check (visible churn, never silent wrongness).
 */

import type { PageSnapshot } from './crawl.js';
import type { Triggered } from './rules.js';
import { siteConfig } from './config.js';

// Answer-engine and user-request fetchers: robots-blocking any of these costs
// citations or classic search presence (Googlebot feeds AI Overviews/AI Mode;
// Bingbot grounds Copilot).
export const ANSWER_ENGINE_BOTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Googlebot',
  'Bingbot',
  'Meta-WebIndexer',
  'DuckAssistBot',
  'MistralAI-User',
  'Amazonbot',
  'Applebot',
];

// Training-corpus crawlers: allow/deny is policy, not citations. Naming any of
// these (or the list above) in robots.txt counts as "explicit AI policy".
export const TRAINING_BOTS = [
  'GPTBot',
  'ClaudeBot',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'meta-externalagent',
  'Bytespider',
];

const FETCH_TIMEOUT_MS = 15_000;
const SAMPLE_PAGES = 3;
// Below this many characters of visible body text, a page reads as empty to a
// non-JS fetcher (nav labels and footer boilerplate alone usually clear it).
const MIN_VISIBLE_TEXT = 200;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export type RobotsGroup = { agents: string[]; allows: string[]; disallows: string[] };

// Minimal REP parser: consecutive User-agent lines open a group that collects
// the Allow/Disallow lines after them; a User-agent line following rules starts
// a new group. Other fields (Sitemap, Crawl-delay) end an agent run but belong
// to no group.
export function parseRobots(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], allows: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(value);
      lastWasAgent = true;
    } else {
      if (current && field === 'allow') current.allows.push(value);
      if (current && field === 'disallow') current.disallows.push(value);
      lastWasAgent = false;
    }
  }
  return groups;
}

/**
 * Longest-match REP evaluation of `path` for `bot`. Exact (case-insensitive)
 * agent-token groups win over the `*` groups; Allow wins length ties. Only
 * trailing wildcards are normalized ("/*" ≡ "/") — mid-pattern wildcards can't
 * affect the "/" evaluation this module does.
 */
export function robotsDecision(groups: RobotsGroup[], bot: string, path = '/'): 'allow' | 'block' {
  const botLc = bot.toLowerCase();
  let matched = groups.filter((g) => g.agents.some((a) => a.toLowerCase() === botLc));
  if (matched.length === 0) matched = groups.filter((g) => g.agents.includes('*'));
  if (matched.length === 0) return 'allow';
  let best: { len: number; verdict: 'allow' | 'block' } = { len: -1, verdict: 'allow' };
  const norm = (rule: string) => rule.replace(/\*+$/, '');
  for (const g of matched) {
    for (const raw of g.allows) {
      const rule = norm(raw);
      if (rule === '') continue;
      if (path.startsWith(rule) && (rule.length > best.len || (rule.length === best.len && best.verdict === 'block'))) {
        best = { len: rule.length, verdict: 'allow' };
      }
    }
    for (const raw of g.disallows) {
      const rule = norm(raw);
      if (rule === '') continue; // "Disallow:" (empty) = allow everything
      if (path.startsWith(rule) && rule.length > best.len) {
        best = { len: rule.length, verdict: 'block' };
      }
    }
  }
  return best.verdict;
}

/** Does robots.txt name any known AI crawler explicitly (allow OR deny)? */
export function hasExplicitAiPolicy(groups: RobotsGroup[]): boolean {
  const known = new Set([...ANSWER_ENGINE_BOTS, ...TRAINING_BOTS].map((b) => b.toLowerCase()));
  return groups.some((g) => g.agents.some((a) => known.has(a.toLowerCase())));
}

/** Classify a fetched text resource (llms.txt-style): real file, absent, or an HTML soft-404. */
export function classifyTextResource(
  status: number,
  contentType: string,
  body: string
): 'ok' | 'missing' | 'soft_404' | 'error' {
  if (status === 404 || status === 410) return 'missing';
  if (status === 0 || status >= 400) return 'error';
  const looksHtml =
    contentType.toLowerCase().includes('text/html') || /^\s*(?:<!doctype|<html)/i.test(body.slice(0, 200));
  return looksHtml ? 'soft_404' : 'ok';
}

/** Visible text a non-JS reader gets from an HTML document's body. <noscript> counts — it renders for them. */
export function visibleBodyText(html: string): string {
  const body = html.split(/<body[^>]*>/i)[1] ?? html;
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

type Fetched = { status: number; contentType: string; body: string; error: string | null };

async function fetchText(url: string, userAgent: string): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': userAgent, accept: '*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body: await res.text(),
      error: null,
    };
  } catch (err) {
    return { status: 0, contentType: '', body: '', error: err instanceof Error ? err.message : String(err) };
  }
}

const AGENT_UA = 'seo-agent/1.1 (aeo-audit; +https://github.com/awizemann/seo-agent)';

export async function aeoChecks(env: Env, snapshots: PageSnapshot[]): Promise<Triggered[]> {
  const cfg = siteConfig(env);
  if (!cfg.aeoChecks) return [];
  const origin = new URL(cfg.siteUrl).origin;
  const out: Triggered[] = [];
  const add = (path: string, rule: string, severity: string, detail: string) =>
    out.push({ path, rule, severity, detail });

  const [robots, llms, llmsFull] = await Promise.all([
    fetchText(`${origin}/robots.txt`, AGENT_UA),
    fetchText(`${origin}/llms.txt`, AGENT_UA),
    fetchText(`${origin}/llms-full.txt`, AGENT_UA),
  ]);

  // --- crawl policy ---
  const robotsState = classifyTextResource(robots.status, robots.contentType, robots.body);
  if (robots.error) {
    add('/robots.txt', 'aeo_check_error', 'info', `robots.txt fetch failed: ${robots.error}`);
  } else if (robotsState === 'missing' || robotsState === 'soft_404' || robotsState === 'error') {
    add('/robots.txt', 'robots_txt_unreachable', 'medium', `robots.txt is ${robotsState === 'missing' ? 'absent' : `unusable (HTTP ${robots.status}, ${robotsState})`} — crawlers assume allow-all, but you can't express an AI policy without it`);
  } else {
    const groups = parseRobots(robots.body);
    const blocked = ANSWER_ENGINE_BOTS.filter((b) => robotsDecision(groups, b, '/') === 'block');
    if (blocked.length > 0) {
      add('/robots.txt', 'robots_blocks_ai_bot', 'high', `robots.txt blocks answer-engine crawler(s): ${blocked.join(', ')} — this silently removes the site from those engines' AI answers/citations`);
    }
    if (!hasExplicitAiPolicy(groups)) {
      add('/robots.txt', 'robots_no_ai_policy', 'info', 'no explicit AI-crawler policy (no known AI bot named) — implicit allow-all works, but an explicit per-bot block documents intent and survives injected/managed robots.txt defaults; see the README\'s recommended policy block');
    }
  }

  // --- ingestion surfaces ---
  const llmsState = classifyTextResource(llms.status, llms.contentType, llms.body);
  if (llms.error) {
    add('/llms.txt', 'aeo_check_error', 'info', `llms.txt fetch failed: ${llms.error}`);
  } else if (llmsState === 'missing') {
    add('/llms.txt', 'llms_txt_missing', 'medium', 'no /llms.txt — a markdown index of your content for AI agents; cheap to serve and some agent tooling fetches it');
  } else if (llmsState === 'soft_404') {
    add('/llms.txt', 'llms_txt_soft_404', 'high', `GET /llms.txt answers HTTP ${llms.status} with HTML (a catch-all shell?) — agents that request it get a misleading non-answer; serve a real text file or a clean 404`);
  }
  if (llmsState === 'ok' && !llmsFull.error) {
    const fullState = classifyTextResource(llmsFull.status, llmsFull.contentType, llmsFull.body);
    if (fullState === 'missing') {
      add('/llms-full.txt', 'llms_full_txt_missing', 'info', 'llms.txt exists but llms-full.txt (full-content corpus) does not — optional; engine adoption of llms files is thin, treat as cheap insurance');
    } else if (fullState === 'soft_404') {
      add('/llms-full.txt', 'llms_txt_soft_404', 'high', `GET /llms-full.txt answers HTTP ${llmsFull.status} with HTML — serve a real text file or a clean 404`);
    }
  }

  // --- AI deliverability sampling ---
  const candidates = snapshots.filter(
    (s) => s.status === 200 && s.path !== '/' && (!cfg.articlePathPrefix || s.path.startsWith(cfg.articlePathPrefix))
  );
  const sample = candidates.slice(0, SAMPLE_PAGES);
  const fetched = await Promise.all(sample.map((s) => fetchText(`${origin}${s.path}`, cfg.aeoBotUa)));
  const botName = cfg.aeoBotUa.match(/compatible;\s*([\w-]+)/)?.[1] || 'the configured AI bot UA';
  for (let i = 0; i < sample.length; i++) {
    const s = sample[i];
    const r = fetched[i];
    if (r.error) {
      add(s.path, 'aeo_check_error', 'info', `AI-UA sample fetch failed: ${r.error}`);
      continue;
    }
    if (r.status === 403 || r.status === 429 || r.status === 451) {
      // The plain-UA crawl of this same path answered 200 this run, so the
      // difference is the user agent — a WAF/CDN/bot-management rule.
      add(s.path, 'ai_page_blocked', 'high', `HTTP ${r.status} for ${botName} while the plain crawl got 200 — an edge/WAF rule is blocking AI crawlers; check your CDN's AI-bot settings`);
      continue;
    }
    if (r.status >= 400) {
      add(s.path, 'aeo_check_error', 'info', `AI-UA sample fetch: HTTP ${r.status}`);
      continue;
    }
    const text = visibleBodyText(r.body);
    const hasArticleBody = /"articleBody"\s*:/.test(r.body);
    if (text.length < MIN_VISIBLE_TEXT && !hasArticleBody) {
      add(s.path, 'ai_page_body_empty', 'high', `${text.length} chars of visible body text for ${botName} and no articleBody JSON-LD — AI crawlers/fetchers don't execute JS, so this page is unreadable (and uncitable) for them at both index and answer time; serve content in the HTML (SSR/static/AI content lane) or at minimum full text in articleBody`);
    }
  }

  console.log(JSON.stringify({ evt: 'aeo_complete', findings: out.length, sampled: sample.length }));
  return out;
}
