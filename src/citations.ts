/**
 * Citation probes — do AI answer engines cite this site for the queries that
 * matter to it? Dormant until configured (the gsc.ts pattern): set
 * CITATION_QUERIES plus at least one engine API key and probes run on the
 * pipeline's weekly citation day (CITATION_CRON_DAY, default Monday UTC) or on
 * demand via POST /aeo/citations/run / the run_citation_check MCP tool.
 *
 * CHEAPEST-FIRST: the default engine is Gemini's Google-Search grounding —
 * grounded requests need a billing-linked Google project (Tier 1; unbilled
 * keys 429 instantly as of mid-2026), but at weekly probe volume the cost is
 * ≈$0 within the monthly grounded allowance. Perplexity / OpenAI / Anthropic
 * activate when their keys are set — a few dollars a month combined. API answers are a PROXY for the consumer UIs (different retrieval
 * stacks), but gained/lost deltas over time are the actionable signal.
 *
 * Results land in the `citations` table; citationFindings() folds the latest
 * state into standard findings: citation_lost (was cited before, not in the
 * latest check) and citation_gained (newly cited, event-style).
 */

import { siteConfig } from './config.js';
import type { Triggered } from './rules.js';

export type CitationSource = { url?: string; domain?: string; title?: string };

type CitEnv = Env & {
  CITATION_QUERIES?: string;
  CITATION_CRON_DAY?: string;
  GEMINI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CITATION_GEMINI_MODEL?: string;
  CITATION_PERPLEXITY_MODEL?: string;
  CITATION_OPENAI_MODEL?: string;
  CITATION_ANTHROPIC_MODEL?: string;
};

const PROBE_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** CITATION_QUERIES accepts a JSON array or |- / newline-separated text. */
export function parseQueries(raw: string): string[] {
  const t = (raw || '').trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const a = JSON.parse(t);
      if (Array.isArray(a)) return a.map(String).map((s) => s.trim()).filter(Boolean);
    } catch {
      // fall through to separator parsing
    }
  }
  return t.split(/\||\n/).map((s) => s.trim()).filter(Boolean);
}

/** First source whose host is (a subdomain of) the site's host. */
export function matchSite(sources: CitationSource[], siteHost: string): { rank: number | null; url: string | null } {
  const host = siteHost.replace(/^www\./, '').toLowerCase();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    for (const cand of [s.domain, s.url]) {
      if (!cand) continue;
      let h = cand.toLowerCase();
      try {
        if (/^https?:/.test(h)) h = new URL(h).hostname;
      } catch {
        continue;
      }
      h = h.replace(/^www\./, '');
      if (h === host || h.endsWith(`.${host}`)) return { rank: i + 1, url: s.url || s.domain || null };
    }
  }
  return { rank: null, url: null };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// Gemini grounding metadata. Note: grounded uris are often Google redirect
// URLs that hide the destination host — the `domain` field (when present) is
// the reliable signal, which is why matchSite checks domain before url.
export function extractGemini(data: any): CitationSource[] {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return chunks
    .map((c: any) => ({ url: c?.web?.uri, domain: c?.web?.domain, title: c?.web?.title }))
    .filter((s: CitationSource) => s.url || s.domain || s.title);
}

export function extractPerplexity(data: any): CitationSource[] {
  return (data?.search_results || [])
    .map((r: any) => ({ url: r?.url, title: r?.title }))
    .filter((s: CitationSource) => s.url);
}

export function extractOpenAI(data: any): CitationSource[] {
  const out: CitationSource[] = [];
  for (const item of data?.output || []) {
    if (item?.type !== 'message') continue;
    for (const c of item?.content || []) {
      for (const a of c?.annotations || []) {
        if (a?.type === 'url_citation' && a.url) out.push({ url: a.url, title: a.title });
      }
    }
  }
  return dedupe(out);
}

export function extractAnthropic(data: any): CitationSource[] {
  const out: CitationSource[] = [];
  for (const block of data?.content || []) {
    for (const cit of block?.citations || []) {
      if (cit?.url) out.push({ url: cit.url, title: cit.title });
    }
    if (block?.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r?.url) out.push({ url: r.url, title: r.title });
    }
  }
  return dedupe(out);
}

function dedupe(sources: CitationSource[]): CitationSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => s.url && !seen.has(s.url) && (seen.add(s.url), true));
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text);
}

type EngineDef = {
  name: string;
  enabled(env: CitEnv): boolean;
  call(env: CitEnv, query: string): Promise<CitationSource[]>;
};

const ENGINES: EngineDef[] = [
  {
    name: 'gemini',
    enabled: (env) => !!env.GEMINI_API_KEY,
    call: async (env, query) => {
      const model = env.CITATION_GEMINI_MODEL || 'gemini-flash-latest';
      const data = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { 'x-goog-api-key': env.GEMINI_API_KEY! },
        { contents: [{ role: 'user', parts: [{ text: query }] }], tools: [{ google_search: {} }] }
      );
      return extractGemini(data);
    },
  },
  {
    name: 'perplexity',
    enabled: (env) => !!env.PERPLEXITY_API_KEY,
    call: async (env, query) => {
      const data = await post(
        'https://api.perplexity.ai/chat/completions',
        { authorization: `Bearer ${env.PERPLEXITY_API_KEY}` },
        { model: env.CITATION_PERPLEXITY_MODEL || 'sonar', messages: [{ role: 'user', content: query }] }
      );
      return extractPerplexity(data);
    },
  },
  {
    name: 'openai',
    enabled: (env) => !!env.OPENAI_API_KEY,
    call: async (env, query) => {
      const data = await post(
        'https://api.openai.com/v1/responses',
        { authorization: `Bearer ${env.OPENAI_API_KEY}` },
        { model: env.CITATION_OPENAI_MODEL || 'gpt-5-mini', input: query, tools: [{ type: 'web_search' }] }
      );
      return extractOpenAI(data);
    },
  },
  {
    name: 'anthropic',
    enabled: (env) => !!env.ANTHROPIC_API_KEY,
    call: async (env, query) => {
      const data = await post(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
        {
          model: env.CITATION_ANTHROPIC_MODEL || 'claude-sonnet-5',
          max_tokens: 1024,
          messages: [{ role: 'user', content: query }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        }
      );
      return extractAnthropic(data);
    },
  },
];

// ---------------------------------------------------------------------------
// The probe runner + findings
// ---------------------------------------------------------------------------

export function citationConfig(env: Env): { queries: string[]; engines: string[]; cronDay: number } {
  const e = env as CitEnv;
  return {
    queries: parseQueries(e.CITATION_QUERIES ?? ''),
    engines: ENGINES.filter((x) => x.enabled(e)).map((x) => x.name),
    cronDay: Number.isInteger(parseInt(e.CITATION_CRON_DAY ?? '', 10)) ? parseInt(e.CITATION_CRON_DAY!, 10) : 1,
  };
}

export async function alreadyCheckedToday(env: Env): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare('SELECT 1 AS x FROM citations WHERE substr(checked_at, 1, 10) = ? LIMIT 1').bind(today).first();
  return !!row;
}

export async function runCitationProbes(env: Env): Promise<{
  checked: number;
  cited: number;
  engines: string[];
  errors: number;
  skipped?: string;
}> {
  const e = env as CitEnv;
  const { queries } = citationConfig(env);
  const engines = ENGINES.filter((x) => x.enabled(e));
  if (queries.length === 0 || engines.length === 0) {
    return {
      checked: 0,
      cited: 0,
      errors: 0,
      engines: engines.map((x) => x.name),
      skipped: queries.length === 0 ? 'no CITATION_QUERIES configured' : 'no engine API key configured (GEMINI_API_KEY is the free-tier default)',
    };
  }

  const host = new URL(siteConfig(env).siteUrl).hostname;
  const checkedAt = new Date().toISOString();
  const insert = env.DB.prepare(
    'INSERT INTO citations (checked_at, engine, query, cited, rank, cited_url, total_sources, sources, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const statements = [];
  let cited = 0;
  let errors = 0;
  for (const engine of engines) {
    for (const query of queries) {
      let sources: CitationSource[] = [];
      let error: string | null = null;
      try {
        sources = await engine.call(e, query);
      } catch (err) {
        error = (err instanceof Error ? err.message : String(err)).slice(0, 700);
        errors++;
      }
      const m = matchSite(sources, host);
      if (m.rank) cited++;
      statements.push(
        insert.bind(
          checkedAt,
          engine.name,
          query,
          m.rank ? 1 : 0,
          m.rank,
          m.url,
          sources.length,
          JSON.stringify(sources.slice(0, 20)).slice(0, 4000),
          error
        )
      );
    }
  }
  if (statements.length > 0) await env.DB.batch(statements);
  const result = { checked: statements.length, cited, errors, engines: engines.map((x) => x.name) };
  console.log(JSON.stringify({ evt: 'citation_probes_complete', ...result }));
  return result;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);

/**
 * Fold citation state into findings (evaluated every pipeline run, cheap):
 *  - citation_lost (medium): the site was cited for (engine, query) in some
 *    earlier check but not in the latest — stays open until regained.
 *  - citation_gained (info): newly cited vs the previous check (event-style;
 *    auto-resolves after the following check).
 */
export async function citationFindings(env: Env): Promise<Triggered[]> {
  const rows = (
    await env.DB.prepare(
      'SELECT engine, query, cited, checked_at FROM citations WHERE error IS NULL ORDER BY checked_at DESC LIMIT 600'
    ).all<{ engine: string; query: string; cited: number; checked_at: string }>()
  ).results;
  if (rows.length === 0) return [];

  const byKey = new Map<string, { engine: string; query: string; states: { cited: number; at: string }[] }>();
  for (const r of rows) {
    const k = `${r.engine} ${r.query}`;
    if (!byKey.has(k)) byKey.set(k, { engine: r.engine, query: r.query, states: [] });
    byKey.get(k)!.states.push({ cited: r.cited, at: r.checked_at });
  }

  const out: Triggered[] = [];
  for (const { engine, query, states } of byKey.values()) {
    const latest = states[0];
    const prev = states[1];
    const everBefore = states.slice(1).some((s) => s.cited === 1);
    const path = `/citation/${engine}/${slug(query)}`;
    if (latest.cited === 0 && everBefore) {
      out.push({
        path,
        rule: 'citation_lost',
        severity: 'medium',
        detail: `${engine} no longer cites the site for "${query}" (was cited in an earlier check; latest ${latest.at.slice(0, 10)})`,
      });
    } else if (latest.cited === 1 && prev && prev.cited === 0) {
      out.push({
        path,
        rule: 'citation_gained',
        severity: 'info',
        detail: `${engine} now cites the site for "${query}" (first seen ${latest.at.slice(0, 10)})`,
      });
    }
  }
  return out;
}
