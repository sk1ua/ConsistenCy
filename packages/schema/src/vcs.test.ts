import { describe, expect, it } from "vitest";
import {
  codeChangeEventSchema,
  gitShaSchema,
  repoRefSchema,
  vcsChangedFileSchema
} from "./vcs";

const detectedAt = "2026-08-05T12:00:00.000Z";
const fullSha = "a".repeat(40);
const otherSha = "b".repeat(40);

const dirtyEvent = {
  type: "WORKING_DIR_DIRTY",
  eventId: "evt-1",
  repository: { root: "D:/sk1ua/python/ConsistenCy" },
  detectedAt
} as const;

describe("vcs change events", () => {
  it("applies local-first defaults so a minimal dirty event is usable", () => {
    const event = codeChangeEventSchema.parse(dirtyEvent);
    expect(event.repository.provider).toBe("local_git");
    expect(event.changedFiles).toEqual([]);
    if (event.type !== "WORKING_DIR_DIRTY") throw new Error("expected a dirty worktree event");
    expect(event.untrackedFiles).toEqual([]);
  });

  it("discriminates every event type in the union", () => {
    expect(codeChangeEventSchema.parse({
      ...dirtyEvent,
      type: "COMMIT_PUSHED",
      sha: fullSha,
      author: { name: "sk1ua" },
      authoredAt: detectedAt,
      message: "feat: add local adapter"
    }).type).toBe("COMMIT_PUSHED");

    expect(codeChangeEventSchema.parse({
      ...dirtyEvent,
      type: "BRANCH_SWITCHED",
      toBranch: "v2",
      toSha: fullSha
    }).type).toBe("BRANCH_SWITCHED");

    expect(codeChangeEventSchema.parse({
      ...dirtyEvent,
      type: "PR_SIMULATION",
      baseRef: "main",
      headRef: "v2",
      baseSha: fullSha,
      headSha: otherSha
    }).type).toBe("PR_SIMULATION");
  });

  it("rejects a PR simulation with nothing to compare", () => {
    expect(() => codeChangeEventSchema.parse({
      ...dirtyEvent,
      type: "PR_SIMULATION",
      baseRef: "main",
      headRef: "v2",
      baseSha: fullSha,
      headSha: fullSha
    })).toThrow();
  });

  it("rejects unknown keys so adapters cannot smuggle untyped metadata", () => {
    expect(() => codeChangeEventSchema.parse({ ...dirtyEvent, impactScore: 0.9 })).toThrow();
  });

  it("accepts abbreviated through sha256 object ids and rejects malformed ones", () => {
    expect(gitShaSchema.parse("abc1234")).toBe("abc1234");
    expect(gitShaSchema.parse("f".repeat(64))).toHaveLength(64);
    expect(() => gitShaSchema.parse("abc123")).toThrow();
    expect(() => gitShaSchema.parse("A".repeat(40))).toThrow();
    expect(() => gitShaSchema.parse("z".repeat(40))).toThrow();
  });

  it("allows a detached HEAD and an empty repository", () => {
    const ref = repoRefSchema.parse({ root: "D:/repo" });
    expect(ref.branch).toBeUndefined();
    expect(ref.headSha).toBeUndefined();
  });
});

describe("vcs changed files", () => {
  it("accepts a zero-based hunk start for a newly added file", () => {
    const file = vcsChangedFileSchema.parse({
      path: "packages/vcs-core/src/local-git-adapter.ts",
      status: "added",
      additions: 12,
      deletions: 0,
      hunks: [{
        header: "@@ -0,0 +1,12 @@",
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 12,
        content: "+export {};"
      }]
    });
    expect(file.binary).toBe(false);
    expect(file.hunks[0]?.oldStart).toBe(0);
  });

  it("requires previousPath for renames and copies", () => {
    const base = { path: "b.ts", additions: 0, deletions: 0 };
    expect(() => vcsChangedFileSchema.parse({ ...base, status: "renamed" })).toThrow();
    expect(vcsChangedFileSchema.parse({
      ...base,
      status: "renamed",
      previousPath: "a.ts"
    }).previousPath).toBe("a.ts");
  });

  it("refuses text hunks on binary files", () => {
    expect(() => vcsChangedFileSchema.parse({
      path: "docs/screenshots/dashboard.png",
      status: "modified",
      additions: 0,
      deletions: 0,
      binary: true,
      hunks: [{
        header: "@@ -1 +1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        content: "binary"
      }]
    })).toThrow();
  });
});
