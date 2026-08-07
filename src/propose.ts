/**
 * Workers AI proposal generation. Description- and title-quality findings feed
 * the model; output is validated hard (length, shape, vocabulary) and invalid
 * output is retried once, then dropped. Proposals default to status=proposed
 * and wait for approval unless the field is listed in the AUTO_APPLY_FIELDS var.
 *
 * One rule fixes itself without a model call: doubled_title_suffix is a pure
 * string surgery (drop the repeated suffix), so it is drafted deterministically
 * — but through the same proposal row, review and apply path as any AI draft.
 */

import { applyOverride, invalidJsonLdReason, invalidCanonicalReason } from './overrides.js';
import { findBannedTerm } from './config.js';
import { TITLE_CORE_MAX, TITLE_TOTAL_MAX, expectedCanonicalUrl } from './rules.js';
import type { SiteConfig } from './config.js';
import type { AgentDeps } from './deps.js';

// The rules the AI drafting pipeline can fix, split by the override field a fix
// lands on. Exported so the "Draft fix" action (actions.draftFinding), the
// per-finding `draftable` flag and the candidate query gate on the exact same
// sets — a button that can't produce a draft never shows.
// `search_impressions_no_clicks` is a DESCRIPTION rule, and the choice is not a
// coin flip. That finding only fires on a page already ranking inside page one
// (it is raised host-side from Search Console data — the library never produces
// it, but the library is what drafts it), so the page's title is load-bearing
// for the ranking that made the click reachable at all, and rewriting it to
// chase a click can cost the position. The description is the one part of the
// snippet Google does not rank on, so it is click-appeal upside with no ranking
// risk. Title experiments on a page-one result belong to a human.
export const DESCRIPTION_RULES = new Set([
  'missing_description', 'short_description', 'long_description', 'truncated_description',
  'search_impressions_no_clicks',
]);
export const TITLE_RULES = new Set(['long_title', 'missing_title', 'duplicate_title', 'doubled_title_suffix']);
/**
 * Rules whose fix is a STRUCTURED DATA block rather than a line of copy. One
 * rule in v1: `missing_article_jsonld`, raised by rules.ts for a page under
 * ARTICLE_PATH_PREFIX that delivers no Article node. The breadth is deliberate
 * — Organization/FAQ/Product markup is a different question (what is TRUE about
 * the business, not what is visible on the page) and does not belong to a
 * per-page drafting pipeline that grounds itself in the crawl.
 */
export const JSONLD_RULES = new Set(['missing_article_jsonld']);
/**
 * Rules whose fix is the page's canonical URL. Like doubled_title_suffix these
 * have exactly one correct answer — expectedCanonicalUrl(siteOrigin, path), the
 * same expression the rule itself checked against — so the drafter is
 * DETERMINISTIC ONLY: no model call ever happens for this field, and a page
 * whose computed canonical fails validation is dropped rather than guessed at.
 */
export const CANONICAL_RULES = new Set(['missing_canonical', 'canonical_mismatch']);
export const PROPOSABLE_RULES = new Set([...DESCRIPTION_RULES, ...TITLE_RULES, ...JSONLD_RULES, ...CANONICAL_RULES]);

/**
 * Description rules whose fix is a REWRITE of a description that is already
 * present and already valid — the page has a description, it is the right
 * length, and it is still not doing its job. For these a draft that comes back
 * identical to the current value is not a fix, so it is rejected (see the
 * validator in draftWithTrace) rather than published as a proposal a reviewer
 * would approve to no effect.
 *
 * A subset of DESCRIPTION_RULES, never a separate lane: everything else about
 * drafting, validating and applying these is the description path unchanged.
 */
export const REWRITE_DESCRIPTION_RULES = new Set(['search_impressions_no_clicks']);

/**
 * Two descriptions are "the same" up to the noise a redraft can introduce
 * without changing what a searcher reads — case, surrounding whitespace and
 * internal whitespace runs. Not a similarity score: this only has to catch the
 * model handing back the string we put in the prompt.
 */
export const sameDescription = (a: string, b: string | null | undefined): boolean =>
  !!b && a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

export type DraftField = 'description' | 'title' | 'jsonld' | 'canonical';

/** The override field a rule's fix lands on, or null when the rule isn't proposable. */
export function fieldForRule(rule: string): DraftField | null {
  if (TITLE_RULES.has(rule)) return 'title';
  if (JSONLD_RULES.has(rule)) return 'jsonld';
  if (CANONICAL_RULES.has(rule)) return 'canonical';
  if (DESCRIPTION_RULES.has(rule)) return 'description';
  return null;
}

/**
 * The CURRENT value of a field for a page, read off its crawl snapshot — the
 * `current` a drafting job carries and the `current_value` a proposal row keeps.
 *
 * `jsonld` is always null, and that is a statement about the snapshot rather
 * than a gap: the crawl records `jsonld_types` (which @types a page delivered),
 * never the JSON-LD source text, so there is no prior document to show a
 * reviewer or hand back to the drafter. It also does not matter for the one
 * rule in this lane — `missing_article_jsonld` fires precisely when the page has
 * no Article node to be the "current" value.
 */
export function currentValueFor(
  field: DraftField,
  snap: { title: string | null; description: string | null; canonical?: string | null }
): string | null {
  if (field === 'jsonld') return null;
  // Null for missing_canonical (there is nothing delivered), the delivered URL
  // for canonical_mismatch — which is exactly what the reviewer should compare.
  if (field === 'canonical') return snap.canonical ?? null;
  return field === 'title' ? snap.title : snap.description;
}

/** SQL literal list for a rule set — module constants only, never caller input. */
export const sqlRuleList = (rules: Set<string>): string => [...rules].map((r) => `'${r}'`).join(', ');

/**
 * The CASE expression mapping a findings row's rule to its proposal field, so
 * the candidate query's "already has a live proposal" test is per (path, field)
 * rather than description-only — a live title proposal must not suppress a
 * description draft on the same page, or vice versa.
 */
export const RULE_FIELD_SQL =
  `CASE WHEN f.rule IN (${sqlRuleList(TITLE_RULES)}) THEN 'title'` +
  ` WHEN f.rule IN (${sqlRuleList(JSONLD_RULES)}) THEN 'jsonld'` +
  ` WHEN f.rule IN (${sqlRuleList(CANONICAL_RULES)}) THEN 'canonical'` +
  ` ELSE 'description' END`;

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

/**
 * The site owner's DRAFTING_GUIDANCE, flattened to a single line. The var is
 * freeform text from the site's own operator, so it is their prompt to shape —
 * but it must not restructure the message it lands in: collapsing every
 * whitespace run means it stays one paragraph and cannot forge the blank-line
 * breaks the rest of the system prompt uses to separate its own instructions.
 * (It is still only ever a `content` string on one message, so it cannot invent
 * a new role turn, and it is interpolated nowhere but here — no other config
 * field is built from it.)
 */
const guidanceLine = (cfg: SiteConfig): string => (cfg.draftingGuidance || '').replace(/\s+/g, ' ').trim();

const systemPrompt = (cfg: SiteConfig): string => {
  const guidance = guidanceLine(cfg);
  return [
    `You write meta descriptions for ${cfg.siteName} (${cfg.siteUrl}), ${cfg.siteDescription}.`,
    ...(guidance ? [`House style for this site: ${guidance}`] : []),
    'Voice: plain, confident, direct. No hype, no buzzwords, no exclamation marks, no emoji, no quotation marks.',
    'Output ONLY the meta description text: one or two complete sentences, between 100 and 158 characters total, ending with a period.',
  ].join('\n');
};

/** Exported for tests: the exact system prompt a config produces. */
export const buildSystemPrompt = systemPrompt;

/**
 * The title-drafting system prompt. Same grounding and injection discipline as
 * the description prompt — the operator's guidance is flattened by the same
 * `guidanceLine` and lands as one line of one message — plus two title-only
 * constraints:
 *
 * - A drafted title is the CORE only, because TITLE_BRAND_SUFFIX is appended by
 *   US at apply time — see the contract on `withTitleSuffix` in overrides.ts.
 *   (Before v1.15.1 this comment claimed the site's own edge layer appended it;
 *   nothing did, and served titles lost their suffix.) The core is what the
 *   reviewer judges and what the proposal row keeps. Emitting the suffix here
 *   would be the doubled_title_suffix bug, so the model is told not to, and the
 *   validator rejects it if it does anyway.
 * - The budget the model is given is the core bound; the total bound is the
 *   validator's job, since only it knows the suffix length.
 */
const titleSystemPrompt = (cfg: SiteConfig): string => {
  const guidance = guidanceLine(cfg);
  const suffix = cfg.titleBrandSuffix;
  return [
    `You write page titles for ${cfg.siteName} (${cfg.siteUrl}), ${cfg.siteDescription}.`,
    ...(guidance ? [`House style for this site: ${guidance}`] : []),
    ...(suffix ? [`The site appends "${suffix}" to every title itself. Never write it — output only the part that comes before it.`] : []),
    'Name the subject the page is actually about. Invent no products, numbers, claims or dates the page does not state.',
    'Voice: plain, confident, direct. No hype, no buzzwords, no exclamation marks, no emoji, no quotation marks.',
    `Output ONLY the title text: one line, at most ${TITLE_CORE_MAX} characters, no trailing period.`,
  ].join('\n');
};

/** Exported for tests: the exact title system prompt a config produces. */
export const buildTitleSystemPrompt = titleSystemPrompt;

/**
 * The JSON-LD system prompt. The whole design of this one is REFUSAL TO
 * INVENT, because structured data is the one field where a plausible guess is
 * actively harmful: a fabricated `author` or `datePublished` is a machine-
 * readable claim about the world, republished under the site's name, that
 * search and answer engines treat as fact and that no reader will ever see to
 * correct. A wrong meta description is bad copy; a wrong `datePublished` is
 * misinformation with a schema around it.
 *
 * So the grounding is narrower than any other lane: the model may use ONLY
 * what the crawl actually observed on the page (title, meta description, and
 * the body excerpt when ARTICLE_API_TEMPLATE is configured), and every field
 * it cannot source from that must be OMITTED. Omission is explicitly the right
 * answer here — a minimal Article node with a correct headline is a complete,
 * valid fix for `missing_article_jsonld`, and the validator does not ask for
 * more (checkJsonLd requires only @context and @type).
 *
 * No house style and no brand suffix: this is data, not prose, so the
 * operator's voice guidance would only tempt the model to editorialize inside
 * a field. `bannedTerms` still applies at approval time (approvalBlockedReason
 * runs the term match on every non-description field, this one included).
 */
const jsonldSystemPrompt = (cfg: SiteConfig): string =>
  [
    `You write schema.org JSON-LD structured data for pages on ${cfg.siteName} (${cfg.siteUrl}).`,
    'Output ONLY a single JSON object. No markdown, no code fences, no commentary, no <script> tag.',
    'It must have "@context": "https://schema.org" and an "@type".',
    'Ground EVERY field in what the page itself shows you below. You may not infer, guess, or supply a typical value.',
    'OMIT any field you cannot read off the page. A short object with three correct fields is right; '
      + 'a complete-looking one with an invented field is wrong.',
    'Never invent an author, a publisher, an organization, a date, an image, a rating, or a price. '
      + 'If the page does not state it, it does not go in.',
  ].join('\n');

/** Exported for tests: the exact JSON-LD system prompt a config produces. */
export const buildJsonLdSystemPrompt = jsonldSystemPrompt;

// What each title rule asks the drafter to change. The rule is the whole brief —
// the same string a description draft carries as its rationale.
const TITLE_RULE_TASK: Record<string, string> = {
  missing_title: 'This page delivers no <title> at all. Write one from the page itself.',
  long_title: 'The current title is too long. Shorten it without losing the page subject.',
  duplicate_title: 'Other pages carry this exact title. Make this one specific to THIS page.',
  doubled_title_suffix: 'The current title repeats the site brand suffix. Write it without the suffix.',
};

/**
 * The facts a title finding's `detail` carries, parsed per rule. The rules
 * module writes each detail in a fixed shape (see runRules); this is the only
 * reader, so the two are a pair — change one, change the other.
 *
 * Fail-soft on purpose: a detail that doesn't match returns empty fields rather
 * than throwing. A finding row is old data, possibly written by an older
 * version, and a missing hint must degrade the prompt, not kill the draft.
 */
export function parseTitleDetail(rule: string, detail: string | null | undefined): { title: string | null; duplicatePaths: string[] } {
  const empty = { title: null, duplicatePaths: [] as string[] };
  if (!detail) return empty;
  if (rule === 'long_title') {
    const m = /^core \d+ chars \(max \d+\), total \d+ \(max \d+\): ([\s\S]+)$/.exec(detail);
    return m ? { title: m[1], duplicatePaths: [] } : empty;
  }
  if (rule === 'doubled_title_suffix') {
    const m = /^title carries the site suffix twice: ([\s\S]+)$/.exec(detail);
    return m ? { title: m[1], duplicatePaths: [] } : empty;
  }
  if (rule === 'duplicate_title') {
    const m = /^same title as: (.+)$/.exec(detail);
    return m ? { title: null, duplicatePaths: m[1].split(', ').filter(Boolean) } : empty;
  }
  return empty; // missing_title carries no title to parse
}

/**
 * The deterministic fix for doubled_title_suffix: the delivered title ends with
 * the brand suffix TWICE (once baked into the stored title, once appended by the
 * site), so the correct stored value is the delivered title minus both. Pure
 * string surgery with one right answer — no model call earns its cost here.
 *
 * Returns null when the input isn't actually doubled, which sends the job down
 * the normal AI path rather than publishing a guess.
 */
export function dedupeTitleSuffix(title: string | null | undefined, suffix: string): string | null {
  if (!title || !suffix) return null;
  if (!title.endsWith(suffix)) return null;
  const core = title.slice(0, -suffix.length);
  if (!core.endsWith(suffix)) return null;
  const deduped = core.slice(0, -suffix.length).trim();
  return deduped || null;
}

/** Two titles are "the same" once the site's appended suffix is discounted. */
function sameTitle(a: string, b: string, suffix: string): boolean {
  const strip = (s: string) => (suffix && s.endsWith(suffix) ? s.slice(0, -suffix.length) : s).trim().toLowerCase();
  return strip(a) === strip(b);
}

/**
 * Why a drafted title is unusable, or null — the title-side twin of
 * invalidReason, and reached only through the same `sanitize` (which strips
 * reasoning-model <think> blocks, wrapping quotes and stray newlines, so
 * injection-shaped output can't survive as prompt structure).
 *
 * `current` is optional: when supplied, a draft that only restates the title we
 * already serve is rejected — a proposal a reviewer cannot act on is worse than
 * no proposal, and the finding re-enqueues next run either way.
 */
export function invalidTitleReason(
  text: string,
  config?: Pick<SiteConfig, 'titleBrandSuffix' | 'bannedTerms'>,
  current?: string | null
): string | null {
  const suffix = config?.titleBrandSuffix || '';
  if (!text) return 'empty output';
  // The site appends the suffix to whatever we store; a draft carrying it is
  // the doubled_title_suffix defect this pipeline exists to fix.
  if (suffix && text.endsWith(suffix)) return `must not repeat the brand suffix "${suffix}" — the site appends it`;
  if (text.length > TITLE_CORE_MAX) return `too long (${text.length} chars, max ${TITLE_CORE_MAX})`;
  if (suffix && text.length + suffix.length > TITLE_TOTAL_MAX) {
    return `too long with the brand suffix (${text.length + suffix.length} chars, max ${TITLE_TOTAL_MAX})`;
  }
  if (current && sameTitle(text, current, suffix)) return 'unchanged from the current title';
  const banned = findBannedTerm(text, config?.bannedTerms);
  if (banned) return `contains banned term "${banned}"`;
  return null;
}

function sanitize(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, '') // reasoning models may prefix thinking
    .trim()
    .replace(/^["'“‘]+|["'’”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Why a description is unusable, or null.
 *
 * `config` is OPTIONAL and second so every existing caller — this is exported
 * and passed by reference as createProposal's validator — keeps working
 * unchanged; without it there is no banned-term check at all, which is exactly
 * the pre-1.13 behavior.
 *
 * Order is deliberate: the shape checks (length, sentence) run first, so a
 * draft that is both malformed and off-vocabulary is corrected on its most
 * mechanical fault first and the retry loop still gets one reason at a time.
 * A term hit is reported last but is equally fatal — a 120-char sentence
 * naming a competitor is invalid no matter how well-formed it is.
 */
export function invalidReason(text: string, config?: Pick<SiteConfig, 'bannedTerms'>): string | null {
  if (text.length < VALUE_MIN) return `too short (${text.length} chars, need ${VALUE_MIN}+)`;
  if (text.length > VALUE_MAX) return `too long (${text.length} chars, max ${VALUE_MAX})`;
  if (!/[.!?]$/.test(text)) return 'must end with a complete sentence';
  const banned = findBannedTerm(text, config?.bannedTerms);
  if (banned) return `contains banned term "${banned}"`;
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

type DraftInput = { path: string; title: string | null; current: string | null; rule?: string; detail?: string | null; description?: string | null };

/**
 * What a description rule asks the drafter to do, when the default brief
 * ("write the meta description") would produce the wrong kind of draft.
 *
 * Only the rules whose brief actually differs appear here; the four
 * length/presence rules are exactly the original lane — there is nothing to say
 * beyond the length window the system prompt already states — and they fall
 * through to the default. Keeping the map sparse means adding an entry is a
 * deliberate statement that this rule needs a different instruction, not
 * boilerplate every rule has to carry.
 */
const DESCRIPTION_RULE_TASK: Record<string, string> = {
  // The page is ON PAGE ONE and is not being clicked, so the existing
  // description is not wrong, it is unpersuasive — a distinction the default
  // brief cannot express. The instruction is about the READER'S DECISION, and
  // it deliberately does not invite invention: a description that promises
  // something the page does not deliver converts one bad number into a worse
  // one. "Must not restate" is enforced, not merely requested (see the
  // unchanged check in draftWithTrace) — a redraft identical to what we already
  // serve is a fix that fixes nothing.
  search_impressions_no_clicks:
    'Google already shows this page high in its results, but people are reading this description and choosing '
    + 'something else. Write a different one that says plainly what the reader gets on this page and why it '
    + 'answers what they were searching for. Lead with the substance, not the site. Promise nothing the page '
    + 'does not actually deliver, and do not restate the current description.',
};

const descriptionUserPrompt = (input: DraftInput, context: string): string =>
  [
    `Page path: ${input.path}`,
    `Page title: ${input.title ?? '(none)'}`,
    `Current description: ${input.current ?? '(none)'}`,
    ...(context ? [`Page content excerpt:\n${context}`] : []),
    '',
    DESCRIPTION_RULE_TASK[input.rule ?? ''] ?? 'Write the meta description.',
  ].join('\n');

// Per-rule routing: the finding's own detail is what distinguishes "too long"
// from "identical to four other pages", so the brief carries the rule's task
// line plus whatever facts parseTitleDetail can recover from that detail.
const titleUserPrompt = (input: DraftInput, context: string): string => {
  const { duplicatePaths } = parseTitleDetail(input.rule ?? '', input.detail);
  return [
    `Page path: ${input.path}`,
    `Current title: ${input.current ?? '(none)'}`,
    `Page description: ${input.description ?? '(none)'}`,
    ...(duplicatePaths.length ? [`Pages already using this exact title: ${duplicatePaths.slice(0, 10).join(', ')}`] : []),
    ...(context ? [`Page content excerpt:\n${context}`] : []),
    '',
    TITLE_RULE_TASK[input.rule ?? ''] ?? 'Write a better title for this page.',
    'Write the title.',
  ].join('\n');
};

/**
 * The JSON-LD brief. It names the three sources the model is allowed to draw
 * on and maps each to the field it may become, so "ground it in the page" is an
 * instruction with referents rather than a slogan. `datePublished` is called out
 * by name because it is the field a model most wants to hallucinate — a crawl
 * snapshot carries no publication date, so unless one is visible in the body
 * excerpt there is nothing to write and the answer is to leave it out.
 */
const jsonldUserPrompt = (input: DraftInput, context: string): string =>
  [
    `Page URL path: ${input.path}`,
    `Page title, as delivered: ${input.title ?? '(none)'}`,
    `Page meta description, as delivered: ${input.description ?? '(none)'}`,
    ...(context ? [`Visible page content:\n${context}`] : []),
    '',
    'This is an article page that carries no Article structured data. Write an Article object for it.',
    'Use the page title for "headline". Use the meta description for "description" if there is one.',
    'Include "datePublished" ONLY if a publication date appears in the page content above — otherwise omit it entirely.',
    'Omit "author", "publisher" and "image" unless the page content above states them.',
    'Return only the JSON object.',
  ].join('\n');

/**
 * Sanitize a JSON-LD draft. Separate from `sanitize` because that one is built
 * for a line of prose and would corrupt JSON on two counts: it collapses every
 * whitespace RUN to a single space (rewriting the contents of string values)
 * and it strips leading/trailing quotes (which for a JSON string value are
 * structure). Here the only cleanup that is safe is removing the wrappers a
 * chat model puts AROUND the document — a reasoning block, a ```json fence —
 * and trimming. Anything left is handed to JSON.parse, which is a far better
 * judge of the rest than a regex.
 */
export function sanitizeJsonLd(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
    .replace(/^```(?:json|ld\+json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/** Draft + validate with full intermediates — powers both the pipeline and the /proposals/dry-run diagnostics endpoint. */
export async function draftWithTrace(
  deps: Pick<AgentDeps, 'ai' | 'config'>,
  input: { path: string; title: string | null; current: string | null; rule?: string; detail?: string | null; description?: string | null }
): Promise<{ value: string | null; trace: DraftTrace[] }> {
  const ai = deps.ai as unknown as TextGenAi;
  const cfg = deps.config;
  // No rule (the dry-run endpoint) means the original lane: a description.
  const field: DraftField = input.rule ? fieldForRule(input.rule) ?? 'description' : 'description';
  const context = await pageContext(cfg, input.path);
  // The rewrite rules ask for a DIFFERENT description, not merely a valid one,
  // so "unchanged from what we serve" is a validation failure for them and the
  // retry turn gets to say so. It is not applied to the length/presence rules:
  // there, an identical draft is already impossible (a `short_description`
  // redraft that matched the current value could not clear VALUE_MIN), and
  // spending the check on them would only add a way for a legitimate draft to
  // be refused.
  const wantsRewrite = !!input.rule && REWRITE_DESCRIPTION_RULES.has(input.rule);
  // A jsonld draft is validated by EXACTLY the function that gates apply
  // (checkJsonLd, via invalidJsonLdReason in overrides.ts) — one definition of
  // publishable, so a draft can never satisfy the drafter and then be refused
  // at the KV boundary. A draft that still fails after the retry turn returns
  // null and is dropped by `draft` below: withdrawn, never stored, exactly as
  // an over-length title or a banned-term description is.
  const validate = (text: string): string | null => {
    if (field === 'jsonld') return invalidJsonLdReason(text);
    if (field === 'title') return invalidTitleReason(text, cfg, input.current);
    if (wantsRewrite && sameDescription(text, input.current)) return 'unchanged from the current description';
    return invalidReason(text, cfg);
  };
  const promptFor = <T,>(jsonld: T, title: T, description: T): T =>
    field === 'jsonld' ? jsonld : field === 'title' ? title : description;
  const messages = [
    { role: 'system', content: promptFor(jsonldSystemPrompt, titleSystemPrompt, systemPrompt)(cfg) },
    { role: 'user', content: promptFor(jsonldUserPrompt, titleUserPrompt, descriptionUserPrompt)(input, context) },
  ];
  const noun = promptFor('JSON-LD object', 'title', 'meta description');
  const trace: DraftTrace[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    // Generous budget: reasoning models (e.g. GLM-4.7-Flash) spend tokens
    // thinking before emitting content — 160 starved it to content:null.
    let out: unknown;
    try {
      out = await withTimeout(ai.run(cfg.aiModel, { messages, max_tokens: 2048 }), AI_CALL_TIMEOUT_MS);
    } catch (err) {
      // Treat a timeout/error as a failed attempt, not a thrown run: the batch
      // continues with the next candidate instead of dying here.
      trace.push({ rawShape: '', raw: '', sanitized: '', reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const raw = extractText(out);
    // JSON must not go through the prose sanitizer — see sanitizeJsonLd.
    const text = field === 'jsonld' ? sanitizeJsonLd(raw) : sanitize(raw);
    // Inside the loop, so the RETRY's output is term-checked exactly as hard as
    // the first draft — a model that swaps one banned term for another still
    // fails, and the draft is dropped rather than published.
    const reason = text ? validate(text) : 'empty output';
    trace.push({ rawShape: JSON.stringify(out)?.slice(0, 400) ?? '', raw, sanitized: text, reason });
    if (!reason) return { value: text, trace };
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `That was invalid: ${reason}. Return only the corrected ${noun}.`,
    });
  }
  return { value: null, trace };
}

async function draft(deps: Pick<AgentDeps, 'ai' | 'config'>, input: DraftInput): Promise<string | null> {
  const { value, trace } = await draftWithTrace(deps, input);
  if (!value) {
    console.log(JSON.stringify({ evt: 'proposal_dropped', path: input.path, reasons: trace.map((t) => t.reason) }));
  }
  return value;
}

// One drafting job — enqueued by a run, drafted by the queue consumer.
// `current` is the current value of the TARGET field (the description for a
// description rule, the delivered title for a title rule); `title` and
// `description` are the page's snapshot values, carried as drafting context.
// `field`, `detail` and `description` are optional so a message enqueued by an
// older version and still in flight still drafts — the field falls back to
// fieldForRule(rule), which answers 'description' for every pre-1.15 rule.
export type DraftJob = {
  findingId: number;
  path: string;
  rule: string;
  title: string | null;
  current: string | null;
  field?: DraftField;
  detail?: string | null;
  description?: string | null;
};

/**
 * Find this run's drafting candidates and enqueue one job each.
 * Fast (no AI in the request path) — the actual drafting happens in the queue
 * consumer, one proposal per invocation, so a slow/variable model call can
 * never stall the run or exceed an invocation budget.
 */
export async function enqueueCandidates(
  deps: Pick<AgentDeps, 'db' | 'draftQueue' | 'config'>,
  runId: number
): Promise<{ enqueued: number }> {
  const max = deps.config.maxProposalsPerRun;
  if (max === 0) return { enqueued: 0 };

  const candidates = (
    await deps.db.prepare(
      `SELECT f.id AS finding_id, f.path, f.rule, f.detail, s.title, s.description, s.canonical
       FROM findings f
       JOIN page_snapshots s ON s.run_id = ?1 AND s.path = f.path
       WHERE f.status = 'open'
         AND f.rule IN (${sqlRuleList(PROPOSABLE_RULES)})
         AND NOT EXISTS (
           SELECT 1 FROM proposals p
           WHERE p.path = f.path AND p.field = ${RULE_FIELD_SQL} AND p.status IN ('proposed', 'approved')
         )
       ORDER BY f.id
       LIMIT ?2`
    )
      .bind(runId, max)
      .all<{ finding_id: number; path: string; rule: string; detail: string | null; title: string | null; description: string | null; canonical: string | null }>()
  ).results;

  const jobs = candidates.flatMap((c) => {
    const field = fieldForRule(c.rule);
    if (!field) return [];
    return [{
      findingId: c.finding_id,
      path: c.path,
      rule: c.rule,
      field,
      detail: c.detail,
      title: c.title,
      description: c.description,
      current: currentValueFor(field, c),
    }];
  });
  for (const job of jobs) await deps.draftQueue.send(job);

  console.log(JSON.stringify({ evt: 'candidates_enqueued', runId, enqueued: jobs.length }));
  return { enqueued: jobs.length };
}

/**
 * Draft one proposal for a queued job and persist it (auto-applying if the
 * field is opted in). Runs in the queue consumer. Throwing signals the queue
 * to retry the message; returning (even with no proposal) acks it.
 *
 * Returns the outcome, including the created proposal's id when one was
 * written. Public API on purpose: a host that wants to guard or auto-reject
 * what this call produced can act on THIS row rather than re-selecting the
 * newest proposal for the (path, field) and racing a concurrent draft.
 * `{ created: false }` means nothing was written — an idempotency skip or a
 * draft that never passed the validator.
 */
export type DraftAndCreateResult =
  | { created: true; proposalId: number; field: string; value: string; autoApplied: boolean }
  | { created: false; field: string };

export async function draftAndCreate(
  deps: Pick<AgentDeps, 'db' | 'overrides' | 'ai' | 'config'>,
  job: DraftJob
): Promise<DraftAndCreateResult> {
  const cfg = deps.config;
  const field = job.field ?? fieldForRule(job.rule) ?? 'description';
  // Idempotency: another run/attempt may have already produced a proposal for
  // this page's SAME field — skip so retries and overlapping runs can't create
  // duplicates, while leaving the page's other field free to be drafted.
  const existing = await deps.db.prepare(
    "SELECT 1 FROM proposals WHERE path = ? AND field = ? AND status IN ('proposed', 'approved') LIMIT 1"
  )
    .bind(job.path, field)
    .first();
  if (existing) return { created: false, field };

  // doubled_title_suffix has exactly one correct fix, so compute it rather than
  // paying for (and risking) a model call. It still goes through the validator:
  // a dedupe that lands over the bound is dropped like any bad draft, and a
  // title that isn't actually doubled falls through to the AI path.
  const deterministic = job.rule === 'doubled_title_suffix' ? dedupeTitleSuffix(job.current, cfg.titleBrandSuffix) : null;
  const dedupedOk = deterministic && !invalidTitleReason(deterministic, cfg, job.current) ? deterministic : null;

  // The canonical field is DETERMINISTIC ONLY (see CANONICAL_RULES): the value
  // is the same expression the rule checked against, and a computed URL that
  // fails validation is dropped — never handed to a model to guess at.
  let value: string | null;
  if (field === 'canonical') {
    const computed = expectedCanonicalUrl(new URL(cfg.siteUrl).origin, job.path);
    value = invalidCanonicalReason(computed) ? null : computed;
  } else {
    value =
      dedupedOk ??
      (await draft(deps, {
        path: job.path,
        title: job.title,
        current: job.current,
        rule: job.rule,
        detail: job.detail,
        description: job.description,
      }));
  }
  // invalid after retries — drop; the open finding re-enqueues next run
  if (!value) return { created: false, field };

  const now = new Date().toISOString();
  const proposal = await deps.db.prepare(
    `INSERT INTO proposals (created_at, finding_id, path, field, current_value, proposed_value, rationale, model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(now, job.findingId, job.path, field, job.current, value, job.rule, dedupedOk || field === 'canonical' ? 'deterministic' : cfg.aiModel)
    .first<{ id: number }>();

  const autoFields = new Set(cfg.autoApplyFields);
  const autoApplied = Boolean(proposal) && autoFields.has(field);
  if (proposal && autoApplied) {
    await applyOverride(deps, { path: job.path, field, value, oldValue: job.current, source: 'auto', proposalId: proposal.id });
    await deps.db.prepare("UPDATE proposals SET status = 'approved', decided_at = ?, applied_at = ? WHERE id = ?")
      .bind(now, now, proposal.id)
      .run();
  }
  console.log(JSON.stringify({ evt: 'proposal_created', path: job.path, field, id: proposal?.id, autoApplied }));
  return proposal ? { created: true, proposalId: proposal.id, field, value, autoApplied } : { created: false, field };
}
