import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKING_TREE_REV, prReviewContextSchema } from "@consistency/schema";
import { execGit } from "@consistency/vcs-core";
import { buildLocalContext } from "./buildLocalContext";

let root: string;
const git = (args: string[]) => execGit(args, { cwd: root });
const write = (name: string, content: string) => writeFileSync(join(root, name), content);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "consistency-local-ctx-"));
  await git(["init"]);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(["config", "user.name", "Test Runner"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "commit.gpgsign", "false"]);

  write("package.json", JSON.stringify({ name: "fixture" }));
  write("keep.ts", "export const keep = 1;\n");
  write("gone.ts", "export const gone = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial commit"]);
}, 60_000);

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("buildLocalContext", { timeout: 30_000 }, () => {
  it("builds a working-tree context with no head commit", async () => {
    write("keep.ts", "export const keep = 2;\n");
    unlinkSync(join(root, "gone.ts"));

    const context = await buildLocalContext({ jobId: "job_local_1", repoPath: root });

    expect(() => prReviewContextSchema.parse(context)).not.toThrow();
    expect(context.source).toBe("local_git");
    expect(context.pullRequestNumber).toBeUndefined();
    expect(context.repositoryFullName).toBe(basename(root));
    expect(context.workspacePath).toBe(root);
    expect(context.headSha).toBe(WORKING_TREE_REV);
    expect(context.baseSha).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("maps a deletion to the status the workflow already branches on", async () => {
    const context = await buildLocalContext({ jobId: "job_local_2", repoPath: root });
    const deleted = context.changedFiles.find((file) => file.path === "gone.ts");

    expect(deleted?.status).toBe("removed");
    // Removed files must not be loaded from the working tree — they are gone.
    expect(context.fileContents["gone.ts"]).toBeUndefined();
    // But their baseline must be available for the diff to be reviewable.
    expect(context.baseFileContents["gone.ts"]).toBe("export const gone = 1;\n");
  });

  it("loads current content and baseline for a modified file", async () => {
    const context = await buildLocalContext({ jobId: "job_local_3", repoPath: root });
    const modified = context.changedFiles.find((file) => file.path === "keep.ts");

    expect(modified?.status).toBe("modified");
    expect(modified?.additions).toBe(1);
    expect(modified?.deletions).toBe(1);
    expect(modified?.patch).toContain("@@");
    expect(context.fileContents["keep.ts"]).toBe("export const keep = 2;\n");
    expect(context.baseFileContents["keep.ts"]).toBe("export const keep = 1;\n");
    expect(context.projectMetadata["package.json"]).toContain("fixture");
  });

  it("reviews a committed range with real revisions on both sides", async () => {
    await git(["add", "."]);
    await git(["commit", "-m", "second commit"]);
    await git(["checkout", "-b", "feature"]);
    write("added.ts", "export const added = 1;\n");
    await git(["add", "."]);
    await git(["commit", "-m", "add file"]);

    const context = await buildLocalContext({
      jobId: "job_local_4",
      repoPath: root,
      baseRef: "main",
      headRef: "feature"
    });

    expect(context.headSha).not.toBe(WORKING_TREE_REV);
    expect(context.headSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(context.baseSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(context.baseSha).not.toBe(context.headSha);
    expect(context.changedFiles.map((file) => file.path)).toEqual(["added.ts"]);
    expect(context.changedFiles[0]?.status).toBe("added");
    expect(context.fileContents["added.ts"]).toBe("export const added = 1;\n");
    // An added file has no baseline to fetch.
    expect(context.baseFileContents["added.ts"]).toBeUndefined();
  });

  it("rejects a half-specified range", async () => {
    await expect(buildLocalContext({ jobId: "job_local_5", repoPath: root, baseRef: "main" }))
      .rejects.toThrow(/must be supplied together/);
  });
});
