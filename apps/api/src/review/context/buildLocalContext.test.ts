import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKING_TREE_REV, prReviewContextSchema } from "@consistency/schema";
import { execGit } from "@consistency/vcs-core";
import { InMemoryJobQueue } from "../../jobQueue";
import { DeterministicAnalyzer } from "../deterministic";
import { MockLLMProvider } from "../llm/mockProvider";
import { createReviewRuntime } from "../workloadRuntime";
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

    const { context } = await buildLocalContext({ jobId: "job_local_1", repoPath: root });

    expect(() => prReviewContextSchema.parse(context)).not.toThrow();
    expect(context.source).toBe("local_git");
    expect(context.pullRequestNumber).toBeUndefined();
    expect(context.repositoryFullName).toBe(basename(root));
    expect(context.workspacePath).toBe(root);
    expect(context.headSha).toBe(WORKING_TREE_REV);
    expect(context.baseSha).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("maps a deletion to the status the workflow already branches on", async () => {
    const { context } = await buildLocalContext({ jobId: "job_local_2", repoPath: root });
    const deleted = context.changedFiles.find((file) => file.path === "gone.ts");

    expect(deleted?.status).toBe("removed");
    // Removed files must not be loaded from the working tree — they are gone.
    expect(context.fileContents["gone.ts"]).toBeUndefined();
    // But their baseline must be available for the diff to be reviewable.
    expect(context.baseFileContents["gone.ts"]).toBe("export const gone = 1;\n");
  });

  it("marks oversized baselines skipped instead of missing", async () => {
    const { context } = await buildLocalContext({ jobId: "job_local_oversized", repoPath: root }, { maxFileBytes: 8 });
    expect(context.baseFileContents["keep.ts"]).toBeUndefined();
    expect(context.skippedBaselinePaths).toContain("keep.ts");
  });

  it("loads current content and baseline for a modified file", async () => {
    const { context } = await buildLocalContext({ jobId: "job_local_3", repoPath: root });
    const modified = context.changedFiles.find((file) => file.path === "keep.ts");

    expect(modified?.status).toBe("modified");
    expect(modified?.additions).toBe(1);
    expect(modified?.deletions).toBe(1);
    expect(modified?.patch).toContain("@@");
    expect(context.fileContents["keep.ts"]).toBe("export const keep = 2;\n");
    expect(context.baseFileContents["keep.ts"]).toBe("export const keep = 1;\n");
    expect(context.projectMetadata["package.json"]).toContain("fixture");
  });


  it("includes untracked-only files as added working-tree changes with content and patches", async () => {
    // Ensure a clean tracked tree so this case is untracked-only.
    await git(["checkout", "--", "."]).catch(() => undefined);
    write("bait-untracked.ts", "export const bait = true;\n");

    const { context } = await buildLocalContext({ jobId: "job_local_untracked", repoPath: root });

    const bait = context.changedFiles.find((file) => file.path === "bait-untracked.ts");
    expect(bait?.status).toBe("added");
    expect(bait?.additions).toBeGreaterThan(0);
    expect(bait?.patch).toContain("+export const bait = true;");
    expect(context.fileContents["bait-untracked.ts"]).toBe("export const bait = true;\n");
    expect(context.baseFileContents["bait-untracked.ts"]).toBeUndefined();
    expect(context.diff).toContain("bait-untracked.ts");
  });

  it("reviews a committed range with real revisions on both sides", async () => {
    await git(["add", "."]);
    await git(["commit", "-m", "second commit"]);
    await git(["checkout", "-b", "feature"]);
    write("added.ts", "export const added = 1;\n");
    await git(["add", "."]);
    await git(["commit", "-m", "add file"]);

    const { context } = await buildLocalContext({
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

describe("buildLocalContext range head read", { timeout: 30_000 }, () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const directory of roots) rmSync(directory, { recursive: true, force: true });
  });

  async function commitRange(): Promise<{ root: string; git: (args: string[]) => ReturnType<typeof execGit> }> {
    const root = mkdtempSync(join(tmpdir(), "consistency-range-read-"));
    roots.push(root);
    const git = (args: string[]) => execGit(args, { cwd: root });
    const write = (name: string, content: string) => {
      const full = join(root, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    };
    await git(["init"]);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await git(["config", "user.name", "Test Runner"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "commit.gpgsign", "false"]);
    write("package.json", JSON.stringify({ name: "at-a" }));
    write("keep.ts", "export const keep = \"A\";\n");
    write("drop.ts", "export const drop = 1;\n");
    write("old-name.ts", "export const moved = \"A\";\n");
    write(".env", "TOKEN=secret\n");
    await git(["add", "."]);
    await git(["commit", "-m", "A"]);
    await git(["checkout", "-B", "feature", "main"]);
    write("keep.ts", "export const keep = \"B\";\n");
    write("package.json", JSON.stringify({ name: "at-b" }));
    write(".env", "TOKEN=still-secret\n");
    write("huge.ts", "x".repeat(64));
    await git(["add", "."]);
    await git(["mv", "old-name.ts", "new-name.ts"]);
    write("new-name.ts", "export const moved = \"B\";\n");
    await git(["add", "new-name.ts"]);
    await git(["rm", "drop.ts"]);
    await git(["commit", "-m", "B"]);
    await git(["checkout", "--detach"]);
    write("keep.ts", "export const keep = \"C\";\n");
    write("renamed.ts", "export const renamed = \"C\";\n");
    write("package.json", JSON.stringify({ name: "at-c" }));
    await git(["add", "."]);
    await git(["commit", "-m", "C"]);
    return { root, git };
  }

  it("keeps workspace head contents when the switch is off, even for a range", async () => {
    const { root } = await commitRange();
    const { context } = await buildLocalContext({
      jobId: "job_range_off",
      repoPath: root,
      baseRef: "main",
      headRef: "feature"
    });
    expect(context.fileContents["keep.ts"]).toBe("export const keep = \"C\";\n");
    expect(context.projectMetadata["package.json"]).toContain("at-c");
  });

  it("reads head file contents and metadata from the head revision when the switch is on", async () => {
    const { root, git } = await commitRange();
    const readHead = () => buildLocalContext({
      jobId: "job_range_on",
      repoPath: root,
      baseRef: "main",
      headRef: "feature",
      rangeReadFromGit: true
    }, { maxFileBytes: 32 });
    const atLaterCommit = await readHead();
    await git(["checkout", "feature"]);
    const atHead = await readHead();
    expect(atHead.context.fileContents).toEqual(atLaterCommit.context.fileContents);
    expect(atHead.context.projectMetadata).toEqual(atLaterCommit.context.projectMetadata);
    const { context } = atLaterCommit;
    expect(context.fileContents["keep.ts"]).toBe("export const keep = \"B\";\n");
    expect(context.fileContents["new-name.ts"]).toBe("export const moved = \"B\";\n");
    expect(context.fileContents["old-name.ts"]).toBeUndefined();
    expect(context.fileContents["drop.ts"]).toBeUndefined();
    expect(context.fileContents["huge.ts"]).toBeUndefined();
    expect(context.fileContents[".env"]).toBeUndefined();
    expect(context.projectMetadata["package.json"]).toContain("at-b");
    expect(context.projectMetadata["package.json"]).not.toContain("at-c");
  });

  it("matches the workspace read when the checkout is already at head", async () => {
    const { root, git } = await commitRange();
    await git(["checkout", "feature"]);
    const off = await buildLocalContext({
      jobId: "job_range_at_head_off",
      repoPath: root,
      baseRef: "main",
      headRef: "feature"
    });
    const on = await buildLocalContext({
      jobId: "job_range_at_head_on",
      repoPath: root,
      baseRef: "main",
      headRef: "feature",
      rangeReadFromGit: true
    });
    expect(on.context.fileContents).toEqual(off.context.fileContents);
    expect(on.context.projectMetadata).toEqual(off.context.projectMetadata);
    expect(on.context.baseFileContents).toEqual(off.context.baseFileContents);
    expect(on.context.diff).toBe(off.context.diff);
  });

  it("keeps model requests byte-identical when the checkout is already at head", async () => {
    const { root, git } = await commitRange();
    await git(["checkout", "feature"]);
    const captured: Array<{ schemaName: string; systemPrompt: string; userPrompt: string; jsonSchema: unknown }> = [];
    const provider = new class extends MockLLMProvider {
      protected override async complete(input: { schemaName: string; systemPrompt: string; userPrompt: string; jsonSchema: unknown }) {
        captured.push({
          schemaName: input.schemaName,
          systemPrompt: input.systemPrompt,
          userPrompt: input.userPrompt,
          jsonSchema: input.jsonSchema
        });
        return super.complete(input);
      }
    }();
    const analyzer = new DeterministicAnalyzer();
    const run = async (rangeReadFromGit: boolean) => {
      const before = captured.length;
      const store = new InMemoryJobQueue();
      const job = store.acceptWebhookJob({
        delivery: { deliveryId: `range-${rangeReadFromGit}`, event: "pull_request", action: "opened" },
        job: {
          kind: "pull_request",
          repository: "test/example",
          pullRequestNumber: 1,
          installationId: 1,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          senderLogin: "octocat",
          action: "opened",
          accessMode: "local_git"
        }
      }).job!;
      store.markRunning(job.id);
      await createReviewRuntime({
        contextBuilder: async input => {
          const built = await buildLocalContext({
            jobId: input.jobId,
            repoPath: root,
            baseRef: "main",
            headRef: "feature",
            ...(rangeReadFromGit ? { rangeReadFromGit: true } : {})
          });
          return { ...built.context, repositoryFullName: "test/example", pullRequestNumber: 1 };
        },
        provider,
        jobStore: store,
        deterministicAnalyzer: analyzer,
        reportLanguage: "en-US",
        reviewWorkflow: null
      }).run({
        jobId: job.id,
        repositoryFullName: "test/example",
        pullRequestNumber: 1,
        accessMode: "local_git",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        publicationPolicy: "disabled"
      });
      return captured.slice(before);
    };
    const off = await run(false);
    const on = await run(true);
    expect(on).toEqual(off);
    expect(off.length).toBeGreaterThan(0);
  });

  it("ignores the switch outside range mode", async () => {
    const { root } = await commitRange();
    writeFileSync(join(root, "keep.ts"), "export const keep = \"dirty\";\n");
    const off = await buildLocalContext({ jobId: "job_tree", repoPath: root });
    const on = await buildLocalContext({ jobId: "job_tree", repoPath: root, rangeReadFromGit: true });
    expect(on.context).toEqual(off.context);
    expect(on.changedSurface).toEqual(off.changedSurface);
  });
});

describe("buildLocalContext rename baseline (audit P1-06③)", { timeout: 30_000 }, () => {
  let renameRoot: string;
  const renameGit = (args: string[]) => execGit(args, { cwd: renameRoot });
  const renameWrite = (name: string, content: string) => writeFileSync(join(renameRoot, name), content);

  beforeAll(async () => {
    renameRoot = mkdtempSync(join(tmpdir(), "consistency-local-rename-"));
    await renameGit(["init"]);
    await renameGit(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await renameGit(["config", "user.name", "Test Runner"]);
    await renameGit(["config", "user.email", "test@example.com"]);
    await renameGit(["config", "commit.gpgsign", "false"]);
    renameWrite("moved-old.ts", "export const moved = 1;\n");
    await renameGit(["add", "."]);
    await renameGit(["commit", "-m", "initial"]);
  }, 60_000);

  afterAll(() => {
    if (renameRoot !== undefined) rmSync(renameRoot, { recursive: true, force: true });
  });

  it("loads baseline for a rename via previousPath, keyed under both names", async () => {
    await renameGit(["mv", "moved-old.ts", "moved-new.ts"]);
    const { context } = await buildLocalContext({ jobId: "job_local_rename", repoPath: renameRoot });
    const renamed = context.changedFiles.find(file => file.path === "moved-new.ts");
    expect(renamed?.status).toBe("renamed");
    expect(context.baseFileContents["moved-new.ts"]).toBe("export const moved = 1;\n");
    expect(context.baseFileContents["moved-old.ts"]).toBe("export const moved = 1;\n");
  });
});


describe("buildLocalContext local excludes", { timeout: 30_000 }, () => {
  let excludeRoot: string;
  const excludeGit = (args: string[]) => execGit(args, { cwd: excludeRoot });
  const excludeWrite = (relative: string, content: string) => {
    const full = join(excludeRoot, relative);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };

  beforeAll(async () => {
    excludeRoot = mkdtempSync(join(tmpdir(), "consistency-local-exclude-"));
    await excludeGit(["init"]);
    await excludeGit(["symbolic-ref", "HEAD", "refs/heads/main"]);
    await excludeGit(["config", "user.name", "Test Runner"]);
    await excludeGit(["config", "user.email", "test@example.com"]);
    await excludeGit(["config", "commit.gpgsign", "false"]);
    excludeWrite("keep.ts", "export const keep = 1;\n");
    await excludeGit(["add", "."]);
    await excludeGit(["commit", "-m", "initial"]);
  }, 60_000);

  afterAll(() => {
    if (excludeRoot !== undefined) rmSync(excludeRoot, { recursive: true, force: true });
  });

  it("honors .consistencyignore and CONSISTENCY_LOCAL_REVIEW_EXCLUDE for WORKING_TREE", async () => {
    excludeWrite(".consistencyignore", "artifacts/\napps/cli/src/dogfood*.ts\n");
    excludeWrite("artifacts/noise.png", "png");
    excludeWrite("apps/cli/src/dogfoodBait.ts", "export const bait = 1;\n");
    excludeWrite("real-change.ts", "export const real = 1;\n");

    const previous = process.env.CONSISTENCY_LOCAL_REVIEW_EXCLUDE;
    process.env.CONSISTENCY_LOCAL_REVIEW_EXCLUDE = "scratch.tmp";
    excludeWrite("scratch.tmp", "tmp");
    try {
      const { context } = await buildLocalContext({ jobId: "job_exclude", repoPath: excludeRoot });
      const paths = context.changedFiles.map(file => file.path);
      expect(paths).toContain("real-change.ts");
      expect(paths).not.toContain("artifacts/noise.png");
      expect(paths).not.toContain("apps/cli/src/dogfoodBait.ts");
      expect(paths).not.toContain("scratch.tmp");
    } finally {
      if (previous === undefined) delete process.env.CONSISTENCY_LOCAL_REVIEW_EXCLUDE;
      else process.env.CONSISTENCY_LOCAL_REVIEW_EXCLUDE = previous;
    }
  });
});
