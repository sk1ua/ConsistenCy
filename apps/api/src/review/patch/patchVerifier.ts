import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execGit, type GitExec } from "@consistency/vcs-core";
import { inspectPatch, type PatchInspection, type PatchPolicyOptions } from "./patchPolicy";

export type PatchVerification = {
  /** Policy inspection ran and passed. */
  policy: PatchInspection;
  /** git could apply the patch cleanly. Undefined when policy rejected it. */
  applies?: boolean;
  applyError?: string;
  /** Result from a caller-supplied verifier, when one was provided. */
  verification?: SandboxVerification;
};

export type SandboxVerification = {
  ok: boolean;
  summary: string;
  detail?: string;
};

/**
 * Runs project checks against a patched tree.
 *
 * Deliberately not implemented here. Verifying a fix by running the project's
 * own test suite means executing code that a language model wrote, in a process
 * that can reach the network and the developer's filesystem. A `spawn` into a
 * temp directory is not a sandbox and should not be presented as one, so this
 * is an injection point: supply an implementation backed by real isolation (a
 * container, a VM, a locked-down CI job) if you want executed verification.
 *
 * The temp checkout handed to it is a `--no-hardlinks` clone, so nothing it
 * does can reach the original repository.
 */
export type SandboxVerifier = (checkoutPath: string) => Promise<SandboxVerification>;

export type VerifyPatchOptions = PatchPolicyOptions & {
  /** Repository the patch is written against. */
  repoPath: string;
  runGit?: GitExec;
  sandbox?: SandboxVerifier;
  scratchRoot?: string;
};

/**
 * Validates a suggested patch without modifying the repository.
 *
 * Order matters: policy first, then `git apply --check`, then any caller
 * sandbox. Nothing touches the working tree — `--check` only reports whether
 * the patch would apply, and the sandbox operates on a throwaway clone.
 */
export async function verifyPatch(patch: string, options: VerifyPatchOptions): Promise<PatchVerification> {
  const policy = inspectPatch(patch, options);
  if (!policy.ok) return { policy };

  const runGit = options.runGit ?? execGit;
  const repoPath = resolve(options.repoPath);
  const scratch = mkdtempSync(join(options.scratchRoot ?? tmpdir(), "consistency-patch-"));
  const patchFile = join(scratch, "suggested.patch");

  try {
    writeFileSync(patchFile, patch.endsWith("\n") ? patch : `${patch}\n`, "utf8");

    try {
      await runGit(["apply", "--check", "--whitespace=nowarn", patchFile], { cwd: repoPath });
    } catch (error) {
      return {
        policy,
        applies: false,
        applyError: error instanceof Error ? error.message : "git could not apply the patch"
      };
    }

    if (options.sandbox === undefined) {
      return { policy, applies: true };
    }

    const checkout = join(scratch, "checkout");
    // --no-hardlinks so the clone shares no object files with the original.
    await runGit(["clone", "--no-hardlinks", "--quiet", repoPath, checkout], {
      cwd: scratch,
      allowLocalFileTransport: true
    });
    await runGit(["apply", "--whitespace=nowarn", patchFile], { cwd: checkout });

    return {
      policy,
      applies: true,
      verification: await options.sandbox(checkout)
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
