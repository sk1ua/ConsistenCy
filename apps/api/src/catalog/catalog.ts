/**
 * Read-only catalog projections (R1).
 *
 * Every value here is PROJECTED from in-code constants — the single source of
 * truth lives in the owning package. Nothing in this module invents semantics
 * that do not exist at the source (no fabricated "configurable" flags, no
 * default-filled fields). Responses are strict-parse validated by the routes
 * before they are sent.
 */

import {
  AGENT_CAPABILITY_PROFILES,
  REVIEW_AGENTS,
  REVIEW_DIFF_MAX_CHARS,
  REVIEW_FILE_CONTENTS_MAX_CHARS,
  REVIEW_KERNEL_EVIDENCE_MAX_ENTRIES,
  REVIEW_PROJECT_METADATA_MAX_CHARS,
} from "@consistency/workload-review";
import { SYSCALL_DEFINITIONS } from "@consistency/kernel";
import { analyzerKindSchema, synthesizerKindSchema, verifierKindSchema } from "@consistency/schema";
import { WORKFLOW_RUNTIME_BUILTIN_METADATA } from "../workflow-runtime/definition";
import type {
  BuiltinEngineWorkflowSummary,
  EngineAllowlistCatalog,
  KernelSyscallCatalog,
  ReviewPipelineCatalog,
} from "@consistency/schema";

/** Stable pipeline keys, derived from code identities only. */
const DETERMINISTIC_ANALYZER_KEY = "deterministic-analyzer";

/**
 * Grant-flag → Kernel action materialization. This is the single derivation
 * site for the capability names the workload issues per grant flag; it mirrors
 * `ReviewWorkload.issueCapabilities` in @consistency/workload-review
 * (repo → repo.read, ast → ast.query, evidenceRead → evidence.read,
 * evidenceWrite → evidence.write, llm → llm.invoke). The order below follows
 * AGENT_CAPABILITY_PROFILES field order; tests pin the relationship so a
 * drift on either side fails loudly.
 */
function grantedActionsForProfile(profile: {
  readonly repo: boolean;
  readonly ast: boolean;
  readonly evidenceRead: boolean;
  readonly evidenceWrite: boolean;
  readonly llm: boolean;
}): string[] {
  const actions: string[] = [];
  if (profile.repo) actions.push("repo.read");
  if (profile.ast) actions.push("ast.query");
  if (profile.evidenceRead) actions.push("evidence.read");
  if (profile.evidenceWrite) actions.push("evidence.write");
  if (profile.llm) actions.push("llm.invoke");
  return actions;
}

/**
 * The review pipeline C topology: DeterministicAnalyzer → Supervisor
 * (Planner) → six specialized agents → Synthesizer, exactly as composed by
 * `ReviewWorkload`. Capability grants mirror AGENT_CAPABILITY_PROFILES; the
 * deterministic analyzer deliberately carries no profile because the source
 * assigns it none.
 */
export function buildReviewPipelineCatalog(): ReviewPipelineCatalog {
  const members: ReviewPipelineCatalog["members"] = [
    {
      key: DETERMINISTIC_ANALYZER_KEY,
      kind: "deterministic-analyzer"
    },
    {
      key: "Planner",
      kind: "planner",
      capabilityProfile: "supervisor",
      grants: { ...AGENT_CAPABILITY_PROFILES.supervisor },
      grantedActions: grantedActionsForProfile(AGENT_CAPABILITY_PROFILES.supervisor)
    },
    ...REVIEW_AGENTS.map((agentName): ReviewPipelineCatalog["members"][number] => {
      const grants =
        agentName === "Security"
          ? { ...AGENT_CAPABILITY_PROFILES.security }
          : { ...AGENT_CAPABILITY_PROFILES.specialized };
      return {
        key: agentName,
        kind: "specialized-agent",
        agentName,
        capabilityProfile: agentName === "Security" ? ("security" as const) : ("specialized" as const),
        grants,
        grantedActions: grantedActionsForProfile(grants)
      };
    }),
    {
      key: "Synthesizer",
      kind: "synthesizer",
      capabilityProfile: "synthesizer",
      grants: { ...AGENT_CAPABILITY_PROFILES.synthesizer },
      grantedActions: grantedActionsForProfile(AGENT_CAPABILITY_PROFILES.synthesizer)
    }
  ];

  return {
    members,
    // ContextVM page composition of a review run (policy/task/diff pinned;
    // source/evidence hot) — mirrors buildReviewBaseContext.
    contextPages: [
      { kind: "policy", residency: "pinned" },
      { kind: "task", residency: "pinned" },
      { kind: "diff", residency: "pinned" },
      { kind: "source", residency: "hot" },
      { kind: "evidence", residency: "hot" }
    ],
    budgets: {
      diffMaxChars: REVIEW_DIFF_MAX_CHARS,
      fileContentsMaxChars: REVIEW_FILE_CONTENTS_MAX_CHARS,
      projectMetadataMaxChars: REVIEW_PROJECT_METADATA_MAX_CHARS,
      kernelEvidenceMaxEntries: REVIEW_KERNEL_EVIDENCE_MAX_ENTRIES
    },
    planFields: ["enabledAgents", "skippedAgents", "riskAreas", "reason"]
  };
}

export function buildKernelSyscallCatalog(): KernelSyscallCatalog {
  const syscalls = SYSCALL_DEFINITIONS.map(definition => ({
    action: definition.action,
    effectClass: definition.effect,
    dispatchPolicy: definition.dispatch,
    ...(definition.description === undefined ? {} : { description: definition.description })
  }));
  return {
    syscalls,
    commitIntentActions: SYSCALL_DEFINITIONS
      .filter(definition => definition.dispatch === "intent")
      .map(definition => definition.action)
  };
}

export function buildEngineAllowlistCatalog(
  builtinWorkflows: readonly BuiltinEngineWorkflowSummary[],
  options: { readonly builtinWorkflowsUnavailable?: boolean; readonly runtimeVerification?: (definitionId: string, revisionId: string, checksum: string) => boolean } = {},
): EngineAllowlistCatalog {
  const runtimeVerifiedBuiltins = Object.values(WORKFLOW_RUNTIME_BUILTIN_METADATA)
    .filter(metadata => metadata.id !== "verified-mini-review")
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(metadata => ({
    id: metadata.id,
    namespace: metadata.namespace,
    revision: metadata.revision,
    revisionId: metadata.revisionId,
    checksum: metadata.checksum,
    purpose: metadata.purpose,
    nodeTypes: ["analyzer.deterministic-evidence", "verifier.persisted-evidence"],
    verificationStatus: (options.runtimeVerification?.(metadata.id, metadata.revisionId, metadata.checksum) ? "verified" : "unverified") as "verified" | "unverified",
    verificationContract: metadata.verificationContract,
    verificationMatrixVersion: metadata.verificationMatrixVersion,
    status: metadata.status,
  }));
  return {
    analyzers: [...analyzerKindSchema.options],
    verifiers: [...verifierKindSchema.options],
    synthesizerKinds: [synthesizerKindSchema.value],
    builtinWorkflows: builtinWorkflows.map(workflow => ({ ...workflow })),
    engineLegacyBuiltins: builtinWorkflows.map(workflow => ({ ...workflow })),
    runtimeVerifiedBuiltins,
    ...(options.builtinWorkflowsUnavailable ? { builtinWorkflowsUnavailable: true as const } : {}),
  };
}
