import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewFinding, ReviewReport } from "@consistency/schema";
import { execGit } from "@consistency/vcs-core";
import { InMemoryJobQueue } from "../../jobQueue";
import { applyFindingPatch, FindingPatchError, previewFindingPatch } from "./findingPatch";

let root: string;
const git = (args: string[]) => execGit(args, { cwd: root });

const ORIGINAL = "export const app = 1;\nexport default app;\n";

const GOOD_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  " export const app = 1;",
  "+export const guarded = true;",
  " export default app;"
].join("\n");

const finding: ReviewFinding = {
  id: "finding-1",
  agent: "Security",
  title: "Add a guard",
  severity: "medium",
  confidence: "confirmed",
  file: "src/app.ts",
  startLine: 1,
  endLine: 2,
  evidence: "Unguarded export.",
  reasoning: "A guard flag documents intent.",
  recommendation: "Add guarded export.",
  suggestedPatch: GOOD_PATCH
};

function reportFor(jobId: string): ReviewReport {
  return {
    jobId,
    repositoryFullName: "fixture/repo",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    summary: "One finding with a suggested patch.",
    score: 80,
    riskLevel: "medium",
    findings: [finding],
    agentRuns: [],
    createdAt: "2026-09-18T00:00:00.000Z"
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "consistency-finding-patch-"));
  await git(["init"]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(["config", "user.name", "Test Runner"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "commit.gpgsign", "false"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), ORIGINAL, "utf8");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
}, 60_000);

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("findingPatch", { timeout: 60_000 }, () => {
  it("previews a local_git patch without mutating the tree", async () => {
    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      repository: "fixture",
      repoPath: root,
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      action: "local_trigger"
    });
    jobs.markSucceeded(job.id, reportFor(job.id));

    const preview = await previewFindingPatch(job.id, finding.id, { jobs });
    expect(preview.applyAvailable).toBe(true);
    expect(preview.patch).toContain("export const guarded = true;");
    expect(preview.verification.applies).toBe(true);
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("applies to the working tree without committing", async () => {
    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      repository: "fixture",
      repoPath: root,
      repositoryId: "repo_local_1",
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      action: "local_trigger"
    });
    jobs.markSucceeded(job.id, reportFor(job.id));

    const result = await applyFindingPatch(job.id, finding.id, {
      jobs,
      resolveRegisteredPath: id => (id === "repo_local_1" ? root : undefined)
    });

    expect(result.applied).toBe(true);
    expect(result.committed).toBe(false);
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toContain("export const guarded = true;");

    await git(["checkout", "--", "src/app.ts"]);
  });

  it("refuses apply for public_read jobs", async () => {
    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      repository: "fixture",
      accessMode: "public_read",
      publicationPolicy: "disabled",
      pullRequestNumber: 1,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      action: "opened"
    });
    jobs.markSucceeded(job.id, reportFor(job.id));

    const preview = await previewFindingPatch(job.id, finding.id, { jobs });
    expect(preview.applyAvailable).toBe(false);
    expect(preview.applyUnavailableReason).toMatch(/local_git/);

    await expect(applyFindingPatch(job.id, finding.id, { jobs })).rejects.toMatchObject({
      code: "PATCH_APPLY_UNAVAILABLE",
      statusCode: 403
    });
  });

  it("surfaces FindingPatchError for missing findings", async () => {
    const jobs = new InMemoryJobQueue();
    const job = jobs.enqueue({
      kind: "pull_request",
      repository: "fixture",
      repoPath: root,
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      action: "local_trigger"
    });
    jobs.markSucceeded(job.id, reportFor(job.id));

    await expect(previewFindingPatch(job.id, "missing", { jobs })).rejects.toBeInstanceOf(FindingPatchError);
  });
});
