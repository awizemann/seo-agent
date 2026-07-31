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
export type { SiteConfig } from './config.js';
export { resolveSiteConfig, siteConfigFromEnv } from './config.js';

// ---------------------------------------------------------------------------
// Deps — bindings + config + secrets, as data.
// ---------------------------------------------------------------------------
export type { AgentDeps, AgentSecrets } from './deps.js';
export { depsFromEnv } from './deps.js';

// ---------------------------------------------------------------------------
// Pipeline — the run itself, plus each sense as an independently callable step.
// ---------------------------------------------------------------------------
// `claimRun` is how a non-Worker host gets a run id: it atomically inserts the
// run row, or returns null when a run is already in flight.
export { startRun, claimRun, runPipeline, statusData } from './actions.js';
export { runCrawl, prunePageSnapshots } from './crawl.js';
export { runRules } from './rules.js';
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

// Drafting — the queue consumer half, and the validator the drafts must pass.
export { draftAndCreate, invalidReason } from './propose.js';
export type { DraftJob } from './propose.js';

// ---------------------------------------------------------------------------
// Data types appearing in the signatures above, so consumers never need to
// reach past this module.
// ---------------------------------------------------------------------------
export type { PageSnapshot } from './crawl.js';
export type { Triggered } from './rules.js';
export type { Remediation, RemediationState } from './actions.js';
export type { Phase, Verdict } from './impact.js';
