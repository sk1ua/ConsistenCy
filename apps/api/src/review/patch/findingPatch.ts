import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ReviewFinding, ReviewReport } from "@consistency/schema";
import type { ReviewJob, ReviewJobStore } from "../../jobQueue";
import { applyPatchToWorkingTree } from "./patchApply";
import { inspectPatch, type PatchViolation } from "./patchPolicy";
import { verifyPatch, type PatchVerification } from "./patchVerifier";

export class FindingPatchError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "FindingPatchError";
  }
}

export type FindingPatchDependencies = {
  jobs: ReviewJobStore;
  /**
   * Optional resolver from a registered repository id to its absolute local
   * checkout. When present and the job carries a repositoryId, apply requires
   * the job's repoPath to match the registered path.
   */
  resolveRegisteredPath?: (repositoryId: string) => string | undefined;
};

export type FindingPatchPreview = {
  jobId: string;
  findingId: string;
  accessMode: ReviewJob["accessMode"];
  patch: string;
  touchedPaths: string[];
  /** Whether POST apply is allowed for this job (local_git + registered path). */
  applyAvailable: boolean;
  /** Human-readable reason when apply is unavailable. */
  applyUnavailableReason?: string;
  verification: {
    policyOk: boolean;
    violations: PatchViolation[];
    /** Undefined when the live checkout was not checked (non-local or missing path). */
    applies?: boolean;
    applyError?: string;
  };
};

export type FindingPatchApplyResult = {
  jobId: string;
  findingId: string;
  applied: boolean;
  touchedPaths: string[];
  /** Always false — apply never commits. */
  committed: false;
  message: string;
};

function loadJobFinding(
  jobs: ReviewJobStore,
  jobId: string,
  findingId: string
): { job: ReviewJob; report: ReviewReport; finding: ReviewFinding } {
  const job = jobs.get(jobId);
  if (!job) throw new FindingPatchError("Job not found", "JOB_NOT_FOUND", 404);
  if (!job.result) throw new FindingPatchError("Job report is not ready", "JOB_NOT_READY", 409);
  const finding = job.result.findings.find(item => item.id === findingId);
  if (!finding) throw new FindingPatchError("Finding not found", "FINDING_NOT_FOUND", 404);
  if (!finding.suggestedPatch?.trim()) {
    throw new FindingPatchError("Finding has no suggested patch", "PATCH_NOT_AVAILABLE", 404);
  }
  return { job, report: job.result, finding };
}

function reviewedPathsForFinding(report: ReviewReport, finding: ReviewFinding): string[] {
  const paths = new Set<string>();
  paths.add(finding.file);
  for (const item of report.findings) {
    if (item.file) paths.add(item.file);
  }
  for (const pack of report.retrieval?.packs ?? []) {
    if (pack.file) paths.add(pack.file);
  }
  return [...paths];
}

function resolveLocalCheckout(
  job: ReviewJob,
  dependencies: FindingPatchDependencies
): { repoPath: string } | { unavailableReason: string } {
  if (job.accessMode !== "local_git") {
    return {
      unavailableReason: job.accessMode === "public_read"
        ? "Apply is only available for local_git jobs (public PR analysis is read-only)"
        : "Apply is only available for local_git jobs"
    };
  }
  if (!job.repoPath) {
    return { unavailableReason: "Local job is missing its registered checkout path" };
  }
  const repoPath = resolve(job.repoPath);
  if (!existsSync(repoPath)) {
    return { unavailableReason: "Registered local checkout is no longer available on disk" };
  }
  if (job.repositoryId && dependencies.resolveRegisteredPath) {
    const registered = dependencies.resolveRegisteredPath(job.repositoryId);
    if (!registered) {
      return { unavailableReason: "Repository is no longer registered for local apply" };
    }
    if (resolve(registered) !== repoPath) {
      return { unavailableReason: "Job checkout no longer matches the registered repository path" };
    }
  }
  return { repoPath };
}

function toVerificationSummary(verification: PatchVerification): FindingPatchPreview["verification"] {
  return {
    policyOk: verification.policy.ok,
    violations: verification.policy.violations,
    applies: verification.applies,
    applyError: verification.applyError
  };
}

/**
 * Read-only patch preview for a finding. Never mutates the working tree.
 * When the job is local_git with a live checkout, also runs policy +
 * `git apply --check` so the UI can show whether apply would succeed.
 */
export async function previewFindingPatch(
  jobId: string,
  findingId: string,
  dependencies: FindingPatchDependencies
): Promise<FindingPatchPreview> {
  const { job, report, finding } = loadJobFinding(dependencies.jobs, jobId, findingId);
  const patch = finding.suggestedPatch as string;
  const reviewedPaths = reviewedPathsForFinding(report, finding);
  const checkout = resolveLocalCheckout(job, dependencies);
  const policy = inspectPatch(patch, { reviewedPaths });

  let verificationSummary: FindingPatchPreview["verification"];
  let applyAvailable = false;
  let applyUnavailableReason: string | undefined;

  if ("unavailableReason" in checkout) {
    applyUnavailableReason = checkout.unavailableReason;
    verificationSummary = {
      policyOk: policy.ok,
      violations: policy.violations
    };
  } else {
    const verification = await verifyPatch(patch, {
      repoPath: checkout.repoPath,
      reviewedPaths
    });
    verificationSummary = toVerificationSummary(verification);
    if (!verification.policy.ok) {
      applyUnavailableReason = verification.policy.violations[0]?.message ?? "Patch failed policy checks";
    } else if (verification.applies !== true) {
      applyUnavailableReason = verification.applyError ?? "Patch does not apply cleanly to the working tree";
    } else {
      applyAvailable = true;
    }
  }

  return {
    jobId: job.id,
    findingId: finding.id,
    accessMode: job.accessMode,
    patch,
    touchedPaths: policy.touchedPaths,
    applyAvailable,
    applyUnavailableReason,
    verification: verificationSummary
  };
}

/**
 * Applies a finding's suggested patch to the registered local_git checkout.
 * Leaves changes unstaged/uncommitted. Refuses non-local jobs and unclean applies.
 */
export async function applyFindingPatch(
  jobId: string,
  findingId: string,
  dependencies: FindingPatchDependencies
): Promise<FindingPatchApplyResult> {
  const { job, report, finding } = loadJobFinding(dependencies.jobs, jobId, findingId);
  const checkout = resolveLocalCheckout(job, dependencies);
  if ("unavailableReason" in checkout) {
    throw new FindingPatchError(checkout.unavailableReason, "PATCH_APPLY_UNAVAILABLE", 403);
  }

  const patch = finding.suggestedPatch as string;
  const reviewedPaths = reviewedPathsForFinding(report, finding);
  const result = await applyPatchToWorkingTree(patch, {
    repoPath: checkout.repoPath,
    reviewedPaths
  });

  if (!result.applied) {
    const code = !result.policy.ok ? "PATCH_POLICY_REJECTED" : "PATCH_APPLY_FAILED";
    const status = !result.policy.ok ? 422 : 409;
    throw new FindingPatchError(
      result.applyError ?? result.policy.violations[0]?.message ?? "Patch could not be applied",
      code,
      status,
      {
        violations: result.policy.violations,
        applyError: result.applyError
      }
    );
  }

  return {
    jobId: job.id,
    findingId: finding.id,
    applied: true,
    touchedPaths: result.touchedPaths,
    committed: false,
    message: "Patch applied to the local working tree (unstaged; not committed)"
  };
}
