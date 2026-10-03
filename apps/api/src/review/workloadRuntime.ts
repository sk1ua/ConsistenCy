/**
 * Review runtime adapter — apps/api as HOST: builds the SHA-pinned snapshot
 * and delegates ALL review execution to @consistency/workload-review.
 *
 * Snapshot policy:
 *   - When the review workspace contains the Git objects for headSha
 *     (production github_app clones and local_git checkouts), a TRUE
 *     Git-backed RepositorySnapshot is created.
 *   - Otherwise (test fixtures / synthetic workspaces), a documented
 *     compatibility fallback serves the context builder's SHA-pinned file
 *     contents read-only — never the live mutable checkout.
 *
 * Publication stays on the EXISTING jobStore boundary (PR-5B migrates it to
 * Kernel commit intents); the workload never receives github.publish.
 */

import {
  asRepositorySnapshotId,
  CapabilityBroker,
  CommitCoordinator,
  MemoryJournal,
  makePrincipalId,
  type AuditEvent,
  type CommitIntent,
  type CommitIntentSink,
  type CommitReceipt,
  type JsonValue,
  type Principal,
  type RepositorySnapshotId,
  type RunId,
} from "@consistency/kernel";
import { RepositorySnapshot } from "@consistency/repository";
import { createHash } from "node:crypto";
import {
  ReviewWorkload,
  legacyProviderModelDriver,
  type DeterministicStage,
  type DeterministicFileInput,
  type ModelDriver,
  type ReviewWorkloadOptions,
  type ReviewWorkloadResult,
} from "@consistency/workload-review";
import type {
  DomainAnalyzeResponse,
  PRReviewContext,
  PublicationPolicy,
  ReviewAccessMode,
  ReviewReport,
  TokenUsage,
  WorkflowSpec,
} from "@consistency/schema";
import type { ReviewJobStore } from "../jobQueue";
import type { DeterministicAnalyzer } from "./deterministic";
import { logger } from "../config/logger";
import { tokenUsageFromError, tokenUsageStatus } from "@consistency/schema";
import { sanitizeExecutionError } from "../security/redact";
import { knowledgeIndexPathFor } from "./knowledgeIndex";
import type { LLMProvider } from "./llm/types";
import type { RuntimeRegistry } from "./runtimeRegistry";
import { workflowRunToAnalyzeResult } from "./workflowAdapter";

export const DEFAULT_REVIEW_WORKFLOW = "pr-review";

export type ReviewWorkflowInput = {
  jobId: string;
  repositoryFullName: string;
  pullRequestNumber?: number;
  repoPath?: string;
  installationId?: number;
  accessMode?: ReviewAccessMode;
  baseSha: string;
  headSha: string;
};

export type ContextBuilder = (input: ReviewWorkflowInput) => Promise<PRReviewContext>;

export type ReviewWorkflowDependencies = {
  contextBuilder: ContextBuilder;
  provider?: LLMProvider;
  providerFactory?: (override?: { provider?: string; model?: string }) => LLMProvider | undefined;
  jobStore: ReviewJobStore;
  deterministicAnalyzer: DeterministicAnalyzer;
  reportLanguage?: "zh-CN" | "en-US";
  maxFindingsPerSpecialist?: number;
  minFindingScore?: number;
  maxReportedFindings?: number;
  maxFindingsPerFile?: number;
  deterministicScope?: "diff" | "all";
  reviewWorkflow?: string | null;
  reviewWorkflowSpec?: (name: string) => WorkflowSpec | undefined;
  workspaceRoot?: string;
  /** Persisted knowledge enrichment/recording; enabled unless explicitly false. */
  memoryEnabled?: boolean;
  /** Default-off lean review. Unset keeps the six-agent Planner path. */
  lean?: boolean;
  /** Default-off maintainer-review pass. Requires lean as well. */
  leanReviewer?: boolean;
  /** Default-off Maintainability title filter. Requires lean reviewer as well. */
  leanMaintFilter?: boolean;
  /** Default-off diagnostic recording of withheld findings. */
  reportWithheld?: boolean;
  /** Default-off v2 scoring rubric. Unset keeps the v1 instruction and cap. */
  scoreRubricV2?: boolean;
  /** Default-off compact file context. Unset keeps full numbered files. */
  compactContext?: boolean;
  /** Default-off lean Consistency tightening. Requires lean as well. */
  leanConsistencyStrict?: boolean;
  /** Default-off strict cross-agent merge. Requires lean as well. */
  leanStrictMerge?: boolean;
  runtimeRegistry?: RuntimeRegistry;
};

async function runWorkflowStage(
  analyzer: ReviewWorkflowDependencies["deterministicAnalyzer"],
  workflow: string,
  files: DeterministicFileInput[],
  resolveSpec?: (name: string) => WorkflowSpec | undefined,
  skippedBaselinePaths: readonly string[] = [],
): Promise<DomainAnalyzeResponse> {
  const spec = resolveSpec?.(workflow);
  const response = spec
    ? await analyzer.runWorkflow(workflow, files, { spec })
    : await analyzer.runWorkflow(workflow, files);
  if (!response.ok) return { id: "workflow", ok: false, error: response.error };
  // Audit P1-09: a default workflow with mixed step outcomes must still
  // yield an analyze success carrying the succeeded steps' evidence. Only a
  // protocol/engine failure (ok:false) aborts the review job. Partial step
  // failure is recorded on consensus so coverage can mark deterministicFailed.
  return workflowRunToAnalyzeResult(response.id, response.run, files.map(file => ({
    path: file.path,
    baseline: file.baseline,
    baselineSkipped: skippedBaselinePaths.includes(file.path),
  })));
}

/**
 * Compatibility fallback: read-only snapshot over the context builder's
 * SHA-pinned content (tests / synthetic workspaces without git objects).
 */
function contentBackedSnapshot(context: PRReviewContext): ReviewWorkloadOptions["snapshot"] {
  const id: RepositorySnapshotId = asRepositorySnapshotId("snap_context_backed");
  return {
    id,
    identity: () => ({
      repository: context.repositoryFullName,
      headSha: context.headSha,
      baseSha: context.baseSha,
    }),
    readFile: (path: string) => {
      const content = context.fileContents[path];
      if (content === undefined) {
        throw new Error(`file not present in review context: ${path}`);
      }
      return {
        path,
        content,
        contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
      };
    },
  } as ReviewWorkloadOptions["snapshot"];
}

export type ReviewRuntimeResult = ReviewWorkloadResult & {
  /** Commit coordinator diagnostics — present only when publication is enabled. */
  readonly commit?: {
    readonly intents: readonly CommitIntent[];
    readonly journal: readonly AuditEvent[];
  };
};

export type ReviewRuntime = {
  run(input: ReviewWorkflowInput & { publicationPolicy: PublicationPolicy }): Promise<ReviewRuntimeResult>;
};

/**
 * Per-call cache telemetry. Every model invocation a review run makes —
 * planner, the six specialists, the synthesizer — passes through this log, so
 * the cached-token count is observable per call and not only as a run total.
 *
 * Missing usage stays null/unknown, including failed transport calls. Known
 * counters from partial attempts remain available without implying completeness.
 */
function logModelCall(operation: string, detail: Record<string, string>, usage?: TokenUsage): void {
  const input = usage?.inputTokens ?? null;
  const cached = usage?.cachedTokens ?? null;
  const promptTokens = input !== null ? input + (cached ?? 0) : (usage?.promptTokens ?? null);
  logger.info(
    {
      operation,
      ...detail,
      inputTokens: input,
      outputTokens: usage?.outputTokens ?? null,
      cachedTokens: cached,
      promptTokens,
      usageStatus: tokenUsageStatus(usage),
      cacheReadStatus: usage?.cacheReadStatus ?? (cached === null ? "unknown" : cached > 0 ? "reported" : "unavailable_or_zero")
    },
    "llm.result"
  );
}

/** Records aggregate call results; transport attempts emit llm.invoke in the provider. */
export function withModelCallLogging(driver: ModelDriver): ModelDriver {
  const failed = (operation: string, detail: Record<string, string>, error: unknown) => {
    logModelCall(operation, {
      ...detail, status: "failed",
      reason: sanitizeExecutionError(error instanceof Error ? error.message : String(error))
    }, tokenUsageFromError(error));
  };
  return {
    ...driver,
    invokeStructured: async (request) => {
      const detail = { schemaName: request.schemaName, agent: request.schemaName === "review-plan" ? "Planner" : request.schemaName === "review-summary" ? "Synthesizer" : request.schemaName };
      try {
        const result = await driver.invokeStructured(request);
        logModelCall("structured", { ...detail, status: "completed" }, result.tokenUsage);
        return result;
      } catch (error) {
        failed("structured", detail, error);
        throw error;
      }
    },
    invokeAgentFindings: async (request) => {
      try {
        const result = await driver.invokeAgentFindings(request);
        logModelCall("findings", { agent: request.agent, status: "completed" }, result.tokenUsage);
        return result;
      } catch (error) {
        failed("findings", { agent: request.agent }, error);
        throw error;
      }
    },
    invokeSummary: async (request) => {
      const detail = { schemaName: "review-summary", agent: "Synthesizer" };
      try {
        const result = await driver.invokeSummary(request);
        logModelCall("summary", { ...detail, status: "completed" }, result.tokenUsage);
        return result;
      } catch (error) {
        failed("summary", detail, error);
        throw error;
      }
    }
  };
}

export function createReviewRuntime(dependencies: ReviewWorkflowDependencies): ReviewRuntime {
  const workspaceRoot = dependencies.workspaceRoot ?? ".consistency/workspaces";
  const memoryEnabled = dependencies.memoryEnabled !== false;
  if (!dependencies.provider) {
    throw new Error("LLM provider is not configured. Configure DeepSeek, OpenAI, or Pi in settings before running reviews.");
  }
  const modelDriver = withModelCallLogging(legacyProviderModelDriver(dependencies.provider));

  return {
    async run(input) {
      const context = await dependencies.contextBuilder(input);

      let snapshot: ReviewWorkloadOptions["snapshot"];
      try {
        snapshot = RepositorySnapshot.create({
          repositoryPath: context.workspacePath,
          repository: input.repositoryFullName,
          headSha: input.headSha,
          baseSha: input.baseSha,
        });
      } catch {
        snapshot = contentBackedSnapshot(context);
      }

      const stage: DeterministicStage = {
        analyze: (files) =>
          dependencies.reviewWorkflow === null
            ? dependencies.deterministicAnalyzer.analyze(files)
            : runWorkflowStage(
                dependencies.deterministicAnalyzer,
                dependencies.reviewWorkflow ?? DEFAULT_REVIEW_WORKFLOW,
                files,
                dependencies.reviewWorkflowSpec,
                context.skippedBaselinePaths,
              ),
        composeReview: (files) => dependencies.deterministicAnalyzer.composeReview(files),
        // No-memory removes both Python entrypoints, not just prompt history:
        // relevant_context also writes the index, and record_review reads it.
        relevantContext: memoryEnabled
          ? async (files, targets, indexPath) =>
              dependencies.deterministicAnalyzer.relevantContext(files, targets, { indexPath })
          : undefined,
        recordReview: memoryEnabled
          ? async (record) =>
              dependencies.deterministicAnalyzer.recordReview({
                indexPath: record.indexPath,
                jobId: record.jobId,
                reference: record.reference,
                reportedAt: record.reportedAt,
                coveredFiles: record.coveredFiles,
                findings: record.findings,
              })
          : undefined,
      };

      // ---------------------------------------------------------------------
      // Commit path (PR-5B): the trusted host mediates github.publish through
      // the Kernel CommitCoordinator. The workload never receives
      // github.publish; it only hands the report + jobId back across the
      // persistence boundary. Publication is routed to a durable intent which
      // is persisted by the EXISTING Outbox sink (report + outbox transaction).
      // The commit machinery is built lazily, only when publication is enabled.
      // ---------------------------------------------------------------------
      let commitState: {
        readonly journal: MemoryJournal;
        readonly broker: CapabilityBroker;
        readonly principal: Principal;
        readonly handle: ReturnType<CapabilityBroker["issue"]>;
        readonly coordinator: CommitCoordinator;
      } | undefined;

      let pendingCommit: { jobId: string; report: ReviewReport } | undefined;

      const ensureCommitState = () => {
        if (commitState) return commitState;
        const journal = new MemoryJournal();
        const broker = new CapabilityBroker(journal);
        const principal = { id: makePrincipalId("kernel", "review-commit"), kind: "kernel" as const };
        const handle = broker.issue({
          subject: principal,
          action: "github.publish",
          resource: {
            kind: "github.publish",
            repositoryId: input.repositoryFullName,
            pullNumber: input.pullRequestNumber,
          },
        });
        const sink: CommitIntentSink = {
          async persist(intent: CommitIntent): Promise<CommitReceipt> {
            if (!pendingCommit) {
              throw new Error("Commit sink invoked without a pending report payload");
            }
            // Terminal op = the existing durable report + outbox transaction.
            dependencies.jobStore.persistReportAndEnqueuePublish(pendingCommit.jobId, pendingCommit.report);
            return {
              intentId: intent.id,
              idempotencyKey: intent.idempotencyKey,
              acceptedAt: intent.createdAt,
              status: "accepted",
            };
          },
        };
        const coordinator = new CommitCoordinator(broker, journal, { sink });
        commitState = { journal, broker, principal, handle, coordinator };
        return commitState;
      };

      const workload = new ReviewWorkload({
        snapshot,
        context,
        modelDriver,
        deterministic: stage,
        persistence: {
          saveAgentRun: (run) => dependencies.jobStore.saveAgentRun(run),
          persistReportAndEnqueuePublish: (jobId, report) => {
            // Publication disabled → persist the report only (existing path);
            // no commit intent, no outbox row, no publish capability issued.
            if (input.publicationPolicy === "disabled") {
              return dependencies.jobStore.persistReportAndEnqueuePublish(jobId, report);
            }

            const { principal, handle, coordinator } = ensureCommitState();
            pendingCommit = { jobId, report };
            // Strip undefined-typed fields so the payload is canonicalizable;
            // the durable Outbox row is still written from the raw report.
            const payload = JSON.parse(JSON.stringify(report)) as JsonValue;
            return coordinator.accept({
              principal,
              handle,
              action: "github.publish",
              resource: {
                kind: "github.publish",
                repositoryId: input.repositoryFullName,
                pullNumber: input.pullRequestNumber,
              },
              idempotencyKey: `github_comment:${jobId}`,
              payload,
            });
          },
        },
        reportLanguage: dependencies.reportLanguage ?? "zh-CN",
        maxFindingsPerSpecialist: dependencies.maxFindingsPerSpecialist ?? 3,
        minFindingScore: dependencies.minFindingScore,
        maxReportedFindings: dependencies.maxReportedFindings,
        maxFindingsPerFile: dependencies.maxFindingsPerFile,
        deterministicScope: dependencies.deterministicScope,
        lean: dependencies.lean,
        leanReviewer: dependencies.leanReviewer,
        leanMaintFilter: dependencies.leanMaintFilter,
        reportWithheld: dependencies.reportWithheld,
        scoreRubricV2: dependencies.scoreRubricV2,
        compactContext: dependencies.compactContext,
        leanConsistencyStrict: dependencies.leanConsistencyStrict,
        leanStrictMerge: dependencies.leanStrictMerge,
        publicationPolicy: input.publicationPolicy,
        accessMode: input.accessMode ?? "github_app",
        knowledgeIndexPath: memoryEnabled
          ? knowledgeIndexPathFor(input.repositoryFullName, workspaceRoot)
          : undefined,
        onRunCreated: (info) => {
          runId = info.runId;
          dependencies.runtimeRegistry?.registerLiveRun({
            runId: info.runId,
            jobId: input.jobId,
            workloadKind: "pr_review",
            scheduler: info.scheduler,
            contextManager: info.contextManager,
            baseContextImageId: info.baseContextImage,
            broker: info.broker,
            // Audit P1-07①: job cancellation and the shutdown deadline both
            // reach this workload — aborting in-flight provider calls, not
            // just stopping admission.
            requestCancel: () => workload.cancelRun(),
          });
        },
      });

      let runId: RunId | undefined;
      try {
        const result = await workload.run();
        if (runId) {
          dependencies.runtimeRegistry?.completeRun(runId);
        }
        return {
          ...result,
          commit: commitState
            ? { intents: commitState.coordinator.listIntents(), journal: commitState.journal.entries() }
            : undefined,
        };
      } catch (error) {
        if (runId) {
          dependencies.runtimeRegistry?.completeRun(runId);
        }
        throw error;
      }
    },
  };
}
