/**
 * @consistency/workload-review — the PR Review workload on the Harness OS.
 *
 * Review-domain orchestration ONLY. The KernelScheduler decides what may
 * run; the Supervisor decides what work exists; every protected operation
 * goes through Kernel capability enforcement. No Review agents live in
 * harness-core or apps/api anymore — they live here.
 */

// Workload
export { ReviewWorkload, ReviewCancelledError } from "./workload/review-workload.js";
export {
  REVIEW_AGENTS,
  AGENT_CAPABILITY_PROFILES,
} from "./workload/types.js";
export type {
  ReviewWorkloadOptions,
  ReviewWorkloadResult,
  ReviewPersistence,
  DeterministicStage,
  DeterministicFileInput,
  AgentCapabilityProfile,
  AgentCapabilityRefs,
  AgentFacadeSet,
  AgentAdmittedHook,
  ReviewAgentName,
} from "./workload/types.js";

// Model layer (generic driver + legacy adapter)
export { legacyProviderModelDriver } from "./model/types.js";
export type {
  ModelDriver,
  ModelResult,
  ModelStructuredRequest,
  ModelTextRequest,
  ModelAgentFindingsRequest,
  LegacyProviderLike,
} from "./model/types.js";

// Capability-bound facades
export { CapabilityBoundLLMFacade } from "./facades/llm-facade.js";
export type { TrustedLLMBackend } from "./facades/llm-facade.js";
export { CapabilityBoundEvidenceFacade } from "./facades/evidence-facade.js";
export { CapabilityBoundRepoFacade } from "./facades/repo-facade.js";

// Deterministic grounding internals (tests / future workloads)
export { DeterministicEvidenceRunner } from "./context/evidence-runner.js";
export { buildReviewBaseContext, REVIEW_DIFF_MAX_CHARS } from "./context/review-context.js";
export { applyModelContentPolicy, redactModelVisibleText } from "./context/content-policy.js";
export { groundReviewFindings, buildGroundingContext, changedLineRanges } from "./agents/grounding.js";
export type { GroundingContext, GroundingResult } from "./agents/grounding.js";
export {
  scopeDeterministicFindings,
  scopeEvidenceInputs,
  findingLineReference,
  findingLineReferences,
  isDeterministicStatusLine,
  DETERMINISTIC_SCOPE_PADDING,
} from "./context/deterministic-scope.js";
export type { DeterministicScope } from "./context/deterministic-scope.js";
export {
  buildAgentPrompt,
  reportLanguageInstruction,
  REVIEW_KERNEL_EVIDENCE_MAX_ENTRIES,
  REVIEW_FILE_CONTENTS_MAX_CHARS,
  REVIEW_PROJECT_METADATA_MAX_CHARS,
} from "./agents/prompts.js";
export { deduplicateAndSortFindings, buildReviewReport } from "./synthesis/report.js";
export { summaryForFinalFindings } from "./synthesis/summary.js";
export {
  applyFindingScoreFilter,
  FINDING_SCORE_INSTRUCTION,
  DEFAULT_MIN_FINDING_SCORE,
  DEFAULT_MAX_REPORTED_FINDINGS,
  DEFAULT_MAX_FINDINGS_PER_FILE,
} from "./synthesis/finding-score.js";
export type { FindingScoreFilterOptions, FindingScoreFilterResult } from "./synthesis/finding-score.js";
export { riskBandForFindings } from "@consistency/schema";
export { buildComposeReviewFileResults } from "./synthesis/compose.js";
