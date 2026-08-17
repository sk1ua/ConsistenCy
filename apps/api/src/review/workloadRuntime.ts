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
} from "@consistency/kernel";
import { RepositorySnapshot } from "@consistency/repository";
import { createHash } from "node:crypto";
import {
  ReviewWorkload,
  legacyProviderModelDriver,
  type DeterministicStage,
  type DeterministicFileInput,
  type ReviewWorkloadOptions,
  type ReviewWorkloadResult,
} from "@consistency/workload-review";
import type {
  DomainAnalyzeResponse,
  PRReviewContext,
  PublicationPolicy,
  ReviewReport,
  WorkflowSpec,
} from "@consistency/schema";
import { knowledgeIndexPathFor } from "./knowledgeIndex";
import { workflowRunToAnalyzeResult } from "./workflowAdapter";
import {
  DEFAULT_REVIEW_WORKFLOW,
  type ReviewWorkflowDependencies,
  type ReviewWorkflowInput,
} from "./graph/workflow";

async function runWorkflowStage(
  analyzer: ReviewWorkflowDependencies["deterministicAnalyzer"],
  workflow: string,
  files: DeterministicFileInput[],
  resolveSpec?: (name: string) => WorkflowSpec | undefined,
): Promise<DomainAnalyzeResponse> {
  const spec = resolveSpec?.(workflow);
  const response = spec
    ? await analyzer.runWorkflow(workflow, files, { spec })
    : await analyzer.runWorkflow(workflow, files);
  if (!response.ok) return { id: "workflow", ok: false, error: response.error };
  if (response.run.status !== "succeeded") {
    return {
      id: response.id,
      ok: false,
      error: `Workflow '${workflow}' failed: ${response.run.error ?? "unknown step failure"}`,
    };
  }
  return workflowRunToAnalyzeResult(response.id, response.run);
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

export function createReviewRuntime(dependencies: ReviewWorkflowDependencies): ReviewRuntime {
  const workspaceRoot = dependencies.workspaceRoot ?? ".consistency/workspaces";
  const modelDriver = legacyProviderModelDriver(dependencies.provider);

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
              ),
        composeReview: (files) => dependencies.deterministicAnalyzer.composeReview(files),
        relevantContext: async (files, targets, indexPath) =>
          dependencies.deterministicAnalyzer.relevantContext(files, targets, { indexPath }),
        recordReview: async (record) =>
          dependencies.deterministicAnalyzer.recordReview({
            indexPath: record.indexPath,
            jobId: record.jobId,
            reference: record.reference,
            reportedAt: record.reportedAt,
            coveredFiles: record.coveredFiles,
            findings: record.findings,
          }),
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
        publicationPolicy: input.publicationPolicy,
        accessMode: input.accessMode ?? "github_app",
        knowledgeIndexPath: knowledgeIndexPathFor(input.repositoryFullName, workspaceRoot),
      });

      const result = await workload.run();
      return {
        ...result,
        commit: commitState
          ? { intents: commitState.coordinator.listIntents(), journal: commitState.journal.entries() }
          : undefined,
      };
    },
  };
}
