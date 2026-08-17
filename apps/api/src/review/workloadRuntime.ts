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

export type ReviewRuntime = {
  run(input: ReviewWorkflowInput & { publicationPolicy: PublicationPolicy }): Promise<ReviewWorkloadResult>;
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

      const workload = new ReviewWorkload({
        snapshot,
        context,
        modelDriver,
        deterministic: stage,
        persistence: {
          saveAgentRun: (run) => dependencies.jobStore.saveAgentRun(run),
          persistReportAndEnqueuePublish: (jobId, report) =>
            dependencies.jobStore.persistReportAndEnqueuePublish(jobId, report),
        },
        reportLanguage: dependencies.reportLanguage ?? "zh-CN",
        publicationPolicy: input.publicationPolicy,
        accessMode: input.accessMode ?? "github_app",
        knowledgeIndexPath: knowledgeIndexPathFor(input.repositoryFullName, workspaceRoot),
      });

      return workload.run();
    },
  };
}
