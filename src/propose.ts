/**
 * Workers AI proposal generation. Only description-quality findings feed the
 * model; output is validated hard (length, complete sentence, no quotes) and
 * invalid output is retried once, then dropped. Proposals default to
 * status=proposed and wait for approval unless the field is listed in the
 * AUTO_APPLY_FIELDS var.
 */

import { applyOverride } from './overrides.js';
import { siteConfig, type SiteConfig } from './config.js';

// The description-quality rules the AI drafting pipeline can fix. Exported so the
// "Draft fix" action (actions.draftFinding) and the per-finding `draftable` flag
// gate on the exact same set — a button that can't produce a draft never shows.
export const PROPOSABLE_RULES = new Set(['missing_description', 'short_description', 'long_description', 'truncated_description']);
const VALUE_MIN = 70;
const VALUE_MAX = 160;

// The generated Ai type keys inputs by model-name literal; our model id is
// config-driven (AI_MODEL var), so call through this minimal typed view.
interface TextGenAi {
  run(model: string, inputs: { messages: Array<{ role: string; content: string }>; max_tokens?: number }): Promise<unknown>;
}

// Generous: drafting runs one-per-invocation on the queue, so a slow model
// call only affects its own message (which the queue will retry). The bound is
// a backstop against a genuinely hung call, with headroom for a reasoning model.
const AI_CALL_TIMEOUT_MS = 45_000;

// A single hung/rate-limited model call must not stall a draft indefinitely.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ai.run timeout')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Workers AI response shapes vary by model generation: older models return
// { response }, newer chat models return OpenAI-style { choices[0].message.content }.
function extractText(out: unknown): string {
  if (typeof out === 'string') return out;
  const o = out as Record<string, any>;
  if (typeof o?.response === 'string') return o.response;
  const choice = o?.choices?.[0];
  if (typeof choice?.message?.content === 'string') return choice.message.content;
  if (typeof choice?.text === 'string') return choice.text;
  if (typeof o?.result?.response === 'string') return o.result.response;
  return '';
}

const systemPrompt = (cfg: SiteConfig): string =>
  `You write meta descriptions for ${cfg.siteName} (${cfg.siteUrl}), ${cfg.siteDescription}.
Voice: plain, confident, direct. No hype, no buzzwords, no exclamation marks, no emoji, no quotation marks.
Output ONLY the meta description text: one or two complete sentences, between 100 and 158 characters total, ending with a period.`;

function sanitize(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, '') // reasoning models may prefix thinking
    .trim()
    .replace(/^["'“‘]+|["'’”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function invalidReason(text: string): string | null {
  if (text.length < VALUE_MIN) return `too short (${text.length} chars, need ${VALUE_MIN}+)`;
  if (text.length > VALUE_MAX) return `too long (${text.length} chars, max ${VALUE_MAX})`;
  if (!/[.!?]$/.test(text)) return 'must end with a complete sentence';
  return null;
}

// Optional richer drafting context: when ARTICLE_PATH_PREFIX + ARTICLE_API_TEMPLATE
// are configured, fetch the page's own JSON ({excerpt?, content?}) so the model
// drafts from the body, not just the title. Fully generic — disabled by default,
// and any fetch failure degrades to "" (the model still gets path + title).
async function pageContext(cfg: SiteConfig, path: string): Promise<string> {
  if (!cfg.articlePathPrefix || !cfg.articleApiTemplate || !path.startsWith(cfg.articlePathPrefix)) return '';
  const slug = path.slice(cfg.articlePathPrefix.length).replace(/\/+$/, '');
  if (!slug || slug.includes('/')) return '';
  try {
    const res = await fetch(cfg.articleApiTemplate.replace('{slug}', encodeURIComponent(slug)), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return '';
    const article = (await res.json()) as { excerpt?: string; content?: string };
    const text = [article.excerpt || '', (article.content || '').replace(/<[^>]*>/g, ' ')].join(' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, 1200);
  } catch {
    return '';
  }
}

export type DraftTrace = { rawShape: string; raw: string; sanitized: string; reason: string | null };

/** Draft + validate with full intermediates — powers both the pipeline and the /proposals/dry-run diagnostics endpoint. */
export async function draftWithTrace(
  env: Env,
  input: { path: string; title: string | null; current: string | null }
): Promise<{ value: string | null; trace: DraftTrace[] }> {
  const ai = env.AI as unknown as TextGenAi;
  const cfg = siteConfig(env);
  const context = await pageContext(cfg, input.path);
  const messages = [
    { role: 'system', content: systemPrompt(cfg) },
    {
      role: 'user',
      content: `Page path: ${input.path}\nPage title: ${input.title ?? '(none)'}\nCurrent description: ${input.current ?? '(none)'}${context ? `\nPage content excerpt:\n${context}` : ''}\n\nWrite the meta description.`,
    },
  ];
  const trace: DraftTrace[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    // Generous budget: reasoning models (e.g. GLM-4.7-Flash) spend tokens
    // thinking before emitting content — 160 starved it to content:null.
    let out: unknown;
    try {
      out = await withTimeout(ai.run(env.AI_MODEL, { messages, max_tokens: 2048 }), AI_CALL_TIMEOUT_MS);
    } catch (err) {
      // Treat a timeout/error as a failed attempt, not a thrown run: the batch
      // continues with the next candidate instead of dying here.
      trace.push({ rawShape: '', raw: '', sanitized: '', reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const raw = extractText(out);
    const text = sanitize(raw);
    const reason = text ? invalidReason(text) : 'empty output';
    trace.push({ rawShape: JSON.stringify(out)?.slice(0, 400) ?? '', raw, sanitized: text, reason });
    if (!reason) return { value: text, trace };
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: `That was invalid: ${reason}. Return only the corrected meta description.` });
  }
  return { value: null, trace };
}

async function draft(env: Env, input: { path: string; title: string | null; current: string | null }): Promise<string | null> {
  const { value, trace } = await draftWithTrace(env, input);
  if (!value) {
    console.log(JSON.stringify({ evt: 'proposal_dropped', path: input.path, reasons: trace.map((t) => t.reason) }));
  }
  return value;
}

// One drafting job — enqueued by a run, drafted by the queue consumer.
export type DraftJob = {
  findingId: number;
  path: string;
  rule: string;
  title: string | null;
  current: string | null;
};

/**
 * Find this run's description candidates and enqueue one drafting job each.
 * Fast (no AI in the request path) — the actual drafting happens in the queue
 * consumer, one proposal per invocation, so a slow/variable model call can
 * never stall the run or exceed an invocation budget.
 */
export async function enqueueCandidates(env: Env, runId: number): Promise<{ enqueued: number }> {
  const max = Math.max(0, parseInt(env.MAX_PROPOSALS_PER_RUN, 10) || 0);
  if (max === 0) return { enqueued: 0 };

  const candidates = (
    await env.DB.prepare(
      `SELECT f.id AS finding_id, f.path, f.rule, s.title, s.description
       FROM findings f
       JOIN page_snapshots s ON s.run_id = ?1 AND s.path = f.path
       WHERE f.status = 'open'
         AND f.rule IN ('missing_description', 'short_description', 'long_description', 'truncated_description')
         AND NOT EXISTS (
           SELECT 1 FROM proposals p
           WHERE p.path = f.path AND p.field = 'description' AND p.status IN ('proposed', 'approved')
         )
       ORDER BY f.id
       LIMIT ?2`
    )
      .bind(runId, max)
      .all<{ finding_id: number; path: string; rule: string; title: string | null; description: string | null }>()
  ).results;

  const jobs = candidates
    .filter((c) => PROPOSABLE_RULES.has(c.rule))
    .map((c) => ({ findingId: c.finding_id, path: c.path, rule: c.rule, title: c.title, current: c.description }));
  for (const job of jobs) await env.DRAFT_QUEUE.send(job);

  console.log(JSON.stringify({ evt: 'candidates_enqueued', runId, enqueued: jobs.length }));
  return { enqueued: jobs.length };
}

/**
 * Draft one proposal for a queued job and persist it (auto-applying if the
 * field is opted in). Runs in the queue consumer. Throwing signals the queue
 * to retry the message; returning (even with no proposal) acks it.
 */
export async function draftAndCreate(env: Env, job: DraftJob): Promise<void> {
  // Idempotency: another run/attempt may have already produced a proposal for
  // this page — skip so retries and overlapping runs can't create duplicates.
  const existing = await env.DB.prepare(
    "SELECT 1 FROM proposals WHERE path = ? AND field = 'description' AND status IN ('proposed', 'approved') LIMIT 1"
  )
    .bind(job.path)
    .first();
  if (existing) return;

  const value = await draft(env, { path: job.path, title: job.title, current: job.current });
  if (!value) return; // invalid after retries — drop; the open finding re-enqueues next run

  const now = new Date().toISOString();
  const proposal = await env.DB.prepare(
    `INSERT INTO proposals (created_at, finding_id, path, field, current_value, proposed_value, rationale, model)
     VALUES (?, ?, ?, 'description', ?, ?, ?, ?) RETURNING id`
  )
    .bind(now, job.findingId, job.path, job.current, value, job.rule, env.AI_MODEL)
    .first<{ id: number }>();

  const autoFields = new Set(env.AUTO_APPLY_FIELDS.split(',').map((f) => f.trim()).filter(Boolean));
  if (proposal && autoFields.has('description')) {
    await applyOverride(env, { path: job.path, field: 'description', value, oldValue: job.current, source: 'auto', proposalId: proposal.id });
    await env.DB.prepare("UPDATE proposals SET status = 'approved', decided_at = ?, applied_at = ? WHERE id = ?")
      .bind(now, now, proposal.id)
      .run();
  }
  console.log(JSON.stringify({ evt: 'proposal_created', path: job.path, id: proposal?.id, autoApplied: autoFields.has('description') }));
}
