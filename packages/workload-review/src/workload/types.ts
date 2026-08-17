/**
 * Review workload contracts — options, results, and the compatibility
 * boundaries the apps/api host must satisfy.
 */

import type {
  AgentRun,
  DomainAnalyzeResponse,
  DomainComposeReviewResponse,
  PRReviewContext,
  PublicationPolicy,
  RelevantContext,
  ReviewAccessMode,
  ReviewFinding,
  ReviewReport,
  WireComposeReviewFile,
} from "@consistency/schema";
import type {
  ContextImageId,
  ContextManager,
  EvidenceId,
  EvidenceSnapshot,
  KernelScheduler,
  RunId,
} from "@consistency/kernel";
import type { RepositorySnapshot } from "@consistency/repository";
import type { ModelDriver } from "../model/types.js";
import type { CapabilityBoundEvidenceFacade } from "../facades/evidence-facade.js";
import type { CapabilityBoundLLMFacade } from "../facades/llm-facade.js";
import type { CapabilityBoundRepoFacade } from "../facades/repo-facade.js";

/** The six specialized review agents (mirrors the legacy registry). */
export const REVIEW_AGENTS = [
  "Security",
  "Correctness",
  "Maintainability",
  "Test",
  "Style",
  "ArchitectureAuditor",
] as const;

export type ReviewAgentName = (typeof REVIEW_AGENTS)[number];

export interface DeterministicFileInput {
  path: string;
  content: string;
  baseline?: string;
  language?: string;
  diffHunks?: string[];
}

/**
 * Compatibility boundary for the legacy deterministic engine (Python/stdio).
 * PR-4 analyzers run ALONGSIDE this; the legacy engine stays the primary
 * parity provider during migration.
 */
export interface DeterministicStage {
  analyze(files: DeterministicFileInput[]): Promise<DomainAnalyzeResponse>;
  composeReview(files: WireComposeReviewFile[]): Promise<DomainComposeReviewResponse>;
  relevantContext?(
    files: { path: string; content: string }[],
    targets: string[],
    indexPath: string,
  ): Promise<Record<string, RelevantContext>>;
  recordReview?(input: {
    indexPath: string;
    jobId: string;
    reference: string;
    reportedAt: string;
    coveredFiles: string[];
    findings: { file: string; title: string; severity: string }[];
  }): Promise<unknown>;
}

/**
 * Compatibility boundary for AgentRun telemetry + the existing durable
 * report/outbox path. This is compatibility persistence — NOT runtime
 * authority (ACBs are). PR-5B migrates the underlying boundary to Kernel
 * commit intents.
 */
export interface ReviewPersistence {
  saveAgentRun(run: AgentRun): void;
  persistReportAndEnqueuePublish(jobId: string, report: ReviewReport): unknown;
}

/** Capability profile per agent role (§15) — least privilege, no publish. */
export type AgentCapabilityProfile =
  | "supervisor"
  | "specialized"
  | "security"
  | "synthesizer";

export const AGENT_CAPABILITY_PROFILES: Readonly<
  Record<AgentCapabilityProfile, { readonly repo: boolean; readonly ast: boolean; readonly evidenceRead: boolean; readonly evidenceWrite: boolean; readonly llm: boolean }>
> = {
  supervisor: { repo: true, ast: false, evidenceRead: true, evidenceWrite: false, llm: true },
  specialized: { repo: true, ast: true, evidenceRead: true, evidenceWrite: false, llm: true },
  security: { repo: true, ast: true, evidenceRead: true, evidenceWrite: true, llm: true },
  synthesizer: { repo: false, ast: false, evidenceRead: true, evidenceWrite: false, llm: true },
};

/** Per-agent protected runtime facades (diagnostics + PR-5B integration). */
export interface AgentFacadeSet {
  readonly llm: CapabilityBoundLLMFacade;
  readonly evidence: CapabilityBoundEvidenceFacade;
  readonly repo?: CapabilityBoundRepoFacade;
}

/** @internal diagnostics — issued capability handles per agent (opaque refs). */
export interface AgentCapabilityRefs {
  readonly llm?: { readonly handle: string };
  readonly repo?: { readonly handle: string };
  readonly evidenceRead?: { readonly handle: string };
  readonly evidenceWrite?: { readonly handle: string };
}

/** Observability/test hook fired right after an agent is admitted (RUNNING). */
export type AgentAdmittedHook = (info: {
  readonly agentId: string;
  readonly agentName: string;
  readonly facades: AgentFacadeSet;
  readonly scheduler: KernelScheduler;
  readonly fiberState: number;
  /** Kernel revocation of one of this agent's capabilities (tests/diagnostics). */
  readonly revoke: (kind: "llm" | "repo" | "evidenceRead" | "evidenceWrite") => void;
}) => void | Promise<void>;

export interface ReviewWorkloadOptions {
  /** Immutable SHA-pinned content source (PR-4 RepositorySnapshot). */
  readonly snapshot: RepositorySnapshot;
  /** Diff/metadata built by the host's context builder at the pinned SHAs. */
  readonly context: PRReviewContext;
  readonly modelDriver: ModelDriver;
  readonly deterministic: DeterministicStage;
  readonly persistence: ReviewPersistence;
  readonly reportLanguage: "zh-CN" | "en-US";
  /** Job-level metadata (publication enforcement stays in the host store). */
  readonly publicationPolicy: PublicationPolicy;
  readonly accessMode: ReviewAccessMode;
  /** Scheduler admission concurrency (default 1 — conservative). */
  readonly schedulerConcurrency?: number;
  /** Knowledge index path for history enrichment/memory (best-effort). */
  readonly knowledgeIndexPath?: string;
  /** Observability hook (tests + future Task Manager). */
  readonly onAgentAdmitted?: AgentAdmittedHook;
}

export interface ReviewWorkloadResult {
  readonly report: ReviewReport;
  readonly plan: { enabledAgents: string[]; skippedAgents: string[]; riskAreas: string[]; reason: string };
  readonly runId: RunId;
  readonly findings: readonly ReviewFinding[];
  readonly evidence: readonly EvidenceSnapshot[];
  readonly evidenceIds: readonly EvidenceId[];
  /** Read-only process snapshots (PR-6 Task Manager input). */
  readonly scheduler: KernelScheduler;
  /** @internal diagnostics — the run's ContextManager (COW verification). */
  readonly contextManager: ContextManager;
  readonly baseContextImage: ContextImageId;
  readonly agentContextImages: ReadonlyMap<string, ContextImageId>;
  /** @internal diagnostics — capability handles + facades per agent. */
  readonly agentFacades: ReadonlyMap<string, AgentFacadeSet>;
  /** @internal diagnostics — issued capability handles per agent. */
  readonly agentCapabilities: ReadonlyMap<string, AgentCapabilityRefs>;
  readonly errors: readonly string[];
}
