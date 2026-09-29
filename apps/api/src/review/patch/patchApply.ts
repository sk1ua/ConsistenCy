import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execGit, type GitExec } from "@consistency/vcs-core";
import { type PatchInspection, type PatchPolicyOptions } from "./patchPolicy";
import { verifyPatch, type PatchVerification } from "./patchVerifier";

export type ApplyPatchResult = {
  policy: PatchInspection;
  /** True when the live working tree was modified. */
  applied: boolean;
  touchedPaths: string[];
  applyError?: string;
  /** Verification snapshot from the pre-apply check. */
  verification: PatchVerification;
};

export type ApplyPatchOptions = PatchPolicyOptions & {
  /** Registered local checkout to mutate. Never a throwaway clone. */
  repoPath: string;
  runGit?: GitExec;
  scratchRoot?: string;
};

/**
 * Re-runs policy + `git apply --check`, then applies the patch to the live
 * working tree. Does **not** stage, commit, or push — the tree is left dirty
 * for the developer to review.
 *
 * Callers must already have decided that `repoPath` is the registered
 * local_git checkout for the job. This helper only enforces patch policy and
 * clean application.
 */
export async function applyPatchToWorkingTree(
  patch: string,
  options: ApplyPatchOptions
): Promise<ApplyPatchResult> {
  const verification = await verifyPatch(patch, options);
  if (!verification.policy.ok) {
    return {
      policy: verification.policy,
      applied: false,
      touchedPaths: verification.policy.touchedPaths,
      verification
    };
  }
  if (verification.applies !== true) {
    return {
      policy: verification.policy,
      applied: false,
      touchedPaths: verification.policy.touchedPaths,
      applyError: verification.applyError ?? "Patch does not apply cleanly",
      verification
    };
  }

  const runGit = options.runGit ?? execGit;
  const repoPath = resolve(options.repoPath);
  const scratch = mkdtempSync(join(options.scratchRoot ?? tmpdir(), "consistency-patch-apply-"));
  const patchFile = join(scratch, "suggested.patch");

  try {
    writeFileSync(patchFile, patch.endsWith("\n") ? patch : `${patch}\n`, "utf8");
    try {
      await runGit(["apply", "--whitespace=nowarn", patchFile], { cwd: repoPath });
    } catch (error) {
      return {
        policy: verification.policy,
        applied: false,
        touchedPaths: verification.policy.touchedPaths,
        applyError: error instanceof Error ? error.message : "git could not apply the patch",
        verification
      };
    }

    return {
      policy: verification.policy,
      applied: true,
      touchedPaths: verification.policy.touchedPaths,
      verification
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
