import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execGit } from "@consistency/vcs-core";
import { verifyPatch } from "./patchVerifier";

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

const STALE_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,3 @@",
  " this context does not exist",
  "+export const guarded = true;",
  " neither does this"
].join("\n");

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "consistency-patchrepo-"));
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

describe("verifyPatch", { timeout: 60_000 }, () => {
  it("confirms a well-formed patch applies without touching the tree", async () => {
    const result = await verifyPatch(GOOD_PATCH, { repoPath: root, reviewedPaths: REVIEWED });

    expect(result.policy.ok).toBe(true);
    expect(result.applies).toBe(true);
    // --check must not modify anything.
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("reports a patch that no longer applies", async () => {
    const result = await verifyPatch(STALE_PATCH, { repoPath: root, reviewedPaths: REVIEWED });

    expect(result.policy.ok).toBe(true);
    expect(result.applies).toBe(false);
    expect(result.applyError).toBeTruthy();
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("never reaches git when policy rejects the patch", async () => {
    const forbidden = GOOD_PATCH.replace(/src\/app\.ts/g, ".github/workflows/ci.yml");
    const result = await verifyPatch(forbidden, {
      repoPath: root,
      reviewedPaths: [".github/workflows/ci.yml"]
    });

    expect(result.policy.ok).toBe(false);
    expect(result.applies).toBeUndefined();
  });

  it("runs a caller sandbox against an isolated clone, not the real repo", async () => {
    let observedPath = "";
    let observedContent = "";

    const result = await verifyPatch(GOOD_PATCH, {
      repoPath: root,
      reviewedPaths: REVIEWED,
      sandbox: async checkout => {
        observedPath = checkout;
        observedContent = readFileSync(join(checkout, "src", "app.ts"), "utf8");
        return { ok: true, summary: "checks passed" };
      }
    });

    expect(result.verification).toEqual({ ok: true, summary: "checks passed" });
    // The sandbox saw the patched content...
    expect(observedContent).toContain("export const guarded = true;");
    // ...in a throwaway clone, while the original stayed untouched.
    expect(observedPath.startsWith(root)).toBe(false);
    expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe(ORIGINAL);
  });

  it("grants local file transport only to the isolated clone", async () => {
    // Given
    const calls: Array<{ args: string[]; allowLocalFileTransport?: true }> = [];

    // When
    await verifyPatch(GOOD_PATCH, {
      repoPath: root,
      reviewedPaths: REVIEWED,
      runGit: async (args, options) => {
        calls.push(options.allowLocalFileTransport === true
          ? { args, allowLocalFileTransport: true }
          : { args });
        return execGit(args, options);
      },
      sandbox: async () => ({ ok: true, summary: "checks passed" })
    });

    // Then
    expect(calls).toEqual([
      { args: ["apply", "--check", "--whitespace=nowarn", expect.any(String)] },
      {
        args: ["clone", "--no-hardlinks", "--quiet", root, expect.any(String)],
        allowLocalFileTransport: true
      },
      { args: ["apply", "--whitespace=nowarn", expect.any(String)] }
    ]);
  });

  it("cleans up the scratch directory even when the sandbox throws", async () => {
    let checkoutPath = "";
    await expect(verifyPatch(GOOD_PATCH, {
      repoPath: root,
      reviewedPaths: REVIEWED,
      sandbox: async checkout => {
        checkoutPath = checkout;
        throw new Error("sandbox exploded");
      }
    })).rejects.toThrow("sandbox exploded");

    expect(checkoutPath).not.toBe("");
    expect(() => readFileSync(join(checkoutPath, "src", "app.ts"), "utf8")).toThrow();
  });

  it("skips the clone entirely when no sandbox is supplied", async () => {
    const result = await verifyPatch(GOOD_PATCH, { repoPath: root, reviewedPaths: REVIEWED });
    expect(result.verification).toBeUndefined();
    expect(result.applies).toBe(true);
  });
});
