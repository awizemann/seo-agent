/**
 * Public library entry point.
 *
 * Everything a host application needs to run the agent against its own
 * bindings lives here — build a `SiteConfig` from data, assemble `AgentDeps`
 * with your own D1/KV/Queue/Workers-AI handles, and call the pipeline or the
 * action functions directly. The Worker in `src/index.ts` is just one consumer
 * of this surface.
 *
 * This file is re-exports only: no logic, no Env. Anything NOT exported here is
 * internal and may change in any release. This surface is semver-gated — pin it
 * by tag (see "Use as a library" in the README).
 */

// ---------------------------------------------------------------------------
// Config — the site profile, as data.
// ---------------------------------------------------------------------------
export type { SiteConfig, SiteVarEnv } from './config.js';
// findBannedTerm is exported so a host embedding the library can pre-check copy
// against the same matcher the agent enforces, instead of reimplementing \b.
export { resolveSiteConfig, siteConfigFromEnv, parseTerms, findBannedTerm } from './config.js';

// ---------------------------------------------------------------------------
// Deps — bindings + config + secrets, as data.
// ---------------------------------------------------------------------------
export type { AgentDeps, AgentSecrets, WorkerEnv } from './deps.js';
export { depsFromEnv } from './deps.js';

// ---------------------------------------------------------------------------
// Pipeline — the run itself, plus each sense as an independently callable step.
// ---------------------------------------------------------------------------
// `claimRun` is how a non-Worker host gets a run id: it atomically inserts the
// run row, or returns null when a run is already in flight.
export { startRun, claimRun, runPipeline, statusData } from './actions.js';
export { runCrawl, prunePageSnapshots } from './crawl.js';
export { runRules, discoveryFindings } from './rules.js';
export { aeoChecks } from './aeo.js';
export { ingestGsc } from './gsc.js';
export { impactFindings } from './impact.js';

// Citations — weekly answer-engine probes and the findings they raise.
export { runCitationProbes, citationFindings, citationConfig } from './citations.js';

// ---------------------------------------------------------------------------
// Actions — listing and lifecycle operations behind the API/MCP/dashboard.
// ---------------------------------------------------------------------------
export {
  // Findings
  listFindings,
  dismissFinding,
  restoreFinding,
  draftFinding,
  // Proposals
  listProposals,
  createProposal,
  decideProposal,
  // Why an already-drafted proposal can no longer be applied (vocabulary drift).
  approvalBlockedReason,
  dryRunDraft,
  // Changes and overrides
  listChanges,
  revertById,
  listOverrides,
  // AEO / citations read models
  listAeoHits,
  listCitations,
  runCitationCheck,
  // Errors
  ApiError,
} from './actions.js';

export { analyticsSummary, analyticsPage, analyticsImpact } from './analytics.js';

// llms.txt — build the answer-engine index from the latest crawl, and propose
// it for approval. Approving publishes it as a KV resource override
// (`resource:/llms.txt`), which the site's injector serves.
export { buildLlmsTxt, generateLlmsTxt, createLlmsTxtProposal, LLMS_TXT_MAX_ENTRIES } from './llmstxt.js';
export type { LlmsTxtPage, LlmsTxtConfig } from './llmstxt.js';

// sitemap.xml — build a sitemap from the crawl and propose it, but ONLY for a
// site whose own sitemap could not serve (origin wins). Approving publishes
// `resource:/sitemap.xml`, which the site's injector serves.
export { buildSitemap, generateSitemap, createSitemapProposal, sitemapProposalBlockedReason, SITEMAP_MAX_ENTRIES } from './sitemap.js';
export type { SitemapPage, SitemapConfig } from './sitemap.js';

// robots.txt — append an explicit AI-crawler policy to the origin's own file
// (or synthesize one when it has none) and propose it for approval. Approving
// publishes `resource:/robots.txt`, which REPLACES the origin's response, so
// the generator is append-only by construction.
export { appendAiPolicy, generateRobotsProposal, AI_POLICY_BEGIN, AI_POLICY_END } from './robotstxt.js';

// Resource overrides — the whole-file half of the override layer. The registry
// pins each field's path and content type, so a host reads it rather than
// hard-coding key names.
export {
  RESOURCE_FIELDS,
  RESOURCE_MAX_CHARS,
  resourceKey,
  readResource,
  isPatternSpec,
  fixedResourceSpec,
  resourcePathFor,
  mdTwinPath,
  mdTwinPathReason,
} from './overrides.js';
export type { ResourceSpec, PatternResourceSpec, AnyResourceSpec } from './overrides.js';
// The title suffix contract: what a stored override value actually is. A host
// that writes overrides outside applyOverride must apply the same rule.
export { withTitleSuffix, storedOverrideValue } from './overrides.js';

// Drafting — the queue consumer half, and the validator the drafts must pass.
export { draftAndCreate, invalidReason, type DraftAndCreateResult } from './propose.js';
export type { DraftJob, DraftTrace } from './propose.js';
// `fieldForRule` is the drafting DEDUPE KEY, and that is why it is public.
// `draftAndCreate` resolves a job's field as `job.field ?? fieldForRule(job.rule)
// ?? 'description'` and dedupes on the result, so any host that serialises or
// claims drafting work per (path, field) — as a multi-tenant queue consumer
// must — has to derive the field exactly the way this does. Reimplementing the
// rule sets host-side is a mirror that drifts silently the moment a release
// adds a rule, and a claim on a drifted key guards a collision that is not the
// one that happens. The FUNCTION is exported rather than the rule sets on
// purpose: one answer, and no second copy of the mapping to keep in step.
export { fieldForRule } from './propose.js';
export type { DraftField } from './propose.js';

// ---------------------------------------------------------------------------
// Data types appearing in the signatures above, so consumers never need to
// reach past this module.
// ---------------------------------------------------------------------------
export type { PageSnapshot, Discovery, DiscoveryMode } from './crawl.js';
export type { Triggered } from './rules.js';
export type { Remediation, RemediationState } from './actions.js';
export type { Phase, Verdict } from './impact.js';
