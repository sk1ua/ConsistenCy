import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execGit } from "@consistency/vcs-core";
import { applyPatchToWorkingTree } from "./patchApply";

let root: string;
const git = (args: string[]) => execGit(args, { cwd: root });

const ORIGINAL = "export const app = 1;\nexport default app;\n";
const REVIEWED = ["src/app.ts"];

const GOOD_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  " export const app = 1;",
  "+export const guarded = true;",
  " export default app;"
].join("\n");

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "consistency-patch-apply-"));
  await git(["init"]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(["config", "user.name", "Test Runner"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "commit.gpgsign", "false"]);

  const source = join(root, "src");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "app.ts"), ORIGINAL, "utf8");
  await git(["add", "."]);
  await git(["commit", "-m", "initial commit"]);
}, 60_000);

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("applyPatchToWorkingTree", { timeout: 60_000 }, () => {
  it("applies a clean patch to the live tree without committing", async () => {
    const result = await applyPatchToWorkingTree(GOOD_PATCH, { repoPath: root, reviewedPaths: REVIEWED });

    expect(result.applied).toBe(true);
    expect(result.touchedPaths).toEqual(["src/app.ts"]);
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toContain("export const guarded = true;");

    const status = await git(["status", "--porcelain"]);
    expect(status.stdout.trim()).toMatch(/M\s+src\/app\.ts| src\/app\.ts/);

    // Restore for subsequent tests.
    await git(["checkout", "--", "src/app.ts"]);
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("refuses a policy-violating patch without touching the tree", async () => {
    const forbidden = GOOD_PATCH.replace(/src\/app\.ts/g, ".github/workflows/ci.yml");
    const result = await applyPatchToWorkingTree(forbidden, {
      repoPath: root,
      reviewedPaths: [".github/workflows/ci.yml"]
    });

    expect(result.applied).toBe(false);
    expect(result.policy.ok).toBe(false);
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("refuses a stale patch without touching the tree", async () => {
    const stale = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@",
      " this context does not exist",
      "+export const guarded = true;",
      " neither does this"
    ].join("\n");

    const result = await applyPatchToWorkingTree(stale, { repoPath: root, reviewedPaths: REVIEWED });
    expect(result.applied).toBe(false);
    expect(result.applyError).toBeTruthy();
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
  });
});
