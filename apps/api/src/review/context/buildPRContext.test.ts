import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prReviewContextSchema } from "@consistency/schema";
import type { PullRequestClient } from "../../github/client";
import { buildPRContext } from "./buildPRContext";
import { execSync } from "node:child_process";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("buildPRContext", () => {
  it("builds a bounded context from a GitHub PR and cloned workspace", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "consistency-context-"));
    directories.push(workspaceRoot);
    const client: PullRequestClient = {
      getPullRequest: vi.fn(async () => ({ baseSha: "base123", headSha: "abcdef1234567" })),
      listChangedFiles: vi.fn(async () => [
        { path: "src/index.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "p".repeat(20) },
        { path: ".env", status: "modified", additions: 1, deletions: 0, changes: 1 },
        { path: "removed.ts", status: "removed", additions: 0, deletions: 2, changes: 2 }
      ]),
      getDiff: vi.fn(async () => "d".repeat(20))
    };
    const cloneWorkspace = vi.fn(async ({ jobId, workspaceRoot: root }: { jobId: string; workspaceRoot?: string }) => {
      const workspace = join(root!, jobId);
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src", "index.ts"), "export const value = 1;");
      writeFileSync(join(workspace, ".env"), "TOKEN=must-not-leak");
      writeFileSync(join(workspace, "package.json"), "{\"name\":\"demo\"}");
      return workspace;
    });

    const context = await buildPRContext({
      jobId: "job_123",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 34,
      installationId: 123,
      baseSha: "base123",
      headSha: "abcdef1234567"
    }, {
      authenticator: { getInstallationToken: vi.fn(async () => ({
        token: "installation-token",
        createdAt: "2026-06-11T00:00:00.000Z",
        expiresAt: "2026-06-11T01:00:00.000Z"
      })) },
      clientFactory: () => client,
      cloneWorkspace: cloneWorkspace as typeof import("../../github/clone").clonePullRequestWorkspace,
      workspaceRoot,
      maxDiffBytes: 10,
      maxPatchBytes: 10
    });

    expect(prReviewContextSchema.parse(context)).toEqual(context);
    expect(context.fileContents).toEqual({ "src/index.ts": "export const value = 1;" });
    expect(context.projectMetadata).toEqual({ "package.json": "{\"name\":\"demo\"}" });
    expect(JSON.stringify(context)).not.toContain("must-not-leak");
    expect(context.diff).toContain("[truncated by ConsistenCy]");
    expect(context.changedFiles[0]?.patch).toContain("[truncated by ConsistenCy]");
  });

  it("fails when the PR moved to different SHAs", async () => {
    const client: PullRequestClient = {
      getPullRequest: async () => ({ baseSha: "different", headSha: "abcdef1234567" }),
      listChangedFiles: async () => [],
      getDiff: async () => ""
    };
    await expect(buildPRContext({
      jobId: "job_123",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 34,
      installationId: 123,
      baseSha: "base123",
      headSha: "abcdef1234567"
    }, {
      authenticator: { getInstallationToken: async () => ({
        token: "token",
        createdAt: "2026-06-11T00:00:00.000Z",
        expiresAt: "2026-06-11T01:00:00.000Z"
      }) },
      clientFactory: () => client
    })).rejects.toThrow(/SHAs changed/);
  });

  it("rejects file paths containing NUL bytes before executing git", async () => {
    const cloneWorkspace = vi.fn(async () => tmpdir());
    const runGitFile = vi.fn();
    const client: PullRequestClient = {
      getPullRequest: async () => ({ baseSha: "base123", headSha: "abcdef1234567" }),
      listChangedFiles: async () => [{ path: "malicious\0file.ts", status: "modified", additions: 1, deletions: 1, changes: 2 }],
      getDiff: async () => ""
    };

    await expect(buildPRContext({
      jobId: "job_123",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 34,
      installationId: 123,
      baseSha: "base123",
      headSha: "abcdef1234567"
    }, {
      authenticator: { getInstallationToken: async () => ({ token: "token", createdAt: "", expiresAt: "" }) },
      clientFactory: () => client,
      cloneWorkspace,
      runGitFile
    })).rejects.toThrow(/NUL character/);

    expect(cloneWorkspace).not.toHaveBeenCalled();
    expect(runGitFile).not.toHaveBeenCalled();
  });

  it("safely handles shell injection characters as a single argument using real git repo", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "consistency-git-"));
    directories.push(workspaceRoot);

    // Create a real git repo
    execSync("git init", { cwd: workspaceRoot });
    // Configure user to avoid git commit errors
    execSync("git config user.email 'test@example.com'", { cwd: workspaceRoot });
    execSync("git config user.name 'Test User'", { cwd: workspaceRoot });

    const maliciousFilename = "safe.ts & echo HACKED;";
    writeFileSync(join(workspaceRoot, maliciousFilename), "original content");
    execSync("git add .", { cwd: workspaceRoot });
    execSync('git commit -m "base commit"', { cwd: workspaceRoot });
    const baseSha = execSync("git rev-parse HEAD", { cwd: workspaceRoot }).toString().trim();

    const client: PullRequestClient = {
      getPullRequest: async () => ({ baseSha, headSha: baseSha }),
      listChangedFiles: async () => [{ path: maliciousFilename, status: "modified", additions: 1, deletions: 1, changes: 2 }],
      getDiff: async () => ""
    };

    const context = await buildPRContext({
      jobId: "job_123",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 34,
      installationId: 123,
      baseSha,
      headSha: baseSha
    }, {
      authenticator: { getInstallationToken: async () => ({ token: "token", createdAt: "", expiresAt: "" }) },
      clientFactory: () => client,
      cloneWorkspace: async () => workspaceRoot
    });

    // The baseFileContents must successfully load "original content" despite the malicious filename,
    // and no shell injection should have executed.
    expect(context.baseFileContents[maliciousFilename]).toBe("original content");
  });

  it("safely handles newlines and spaces in file paths via runGitFile (mocked argv)", async () => {
    const runGitFile = vi.fn().mockResolvedValue({ stdout: Buffer.from("mocked output") });
    const client: PullRequestClient = {
      getPullRequest: async () => ({ baseSha: "base123", headSha: "head123" }),
      listChangedFiles: async () => [{ path: "file\nname.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }],
      getDiff: async () => ""
    };

    await buildPRContext({
      jobId: "job_123",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 34,
      installationId: 123,
      baseSha: "base123",
      headSha: "head123"
    }, {
      authenticator: { getInstallationToken: async () => ({ token: "token", createdAt: "", expiresAt: "" }) },
      clientFactory: () => client,
      cloneWorkspace: async () => tmpdir(),
      runGitFile
    });

    expect(runGitFile).toHaveBeenCalledWith(
      "git",
      ["show", "base123:file\nname.ts"],
      expect.objectContaining({ cwd: expect.any(String) })
    );
  });

  it("enforces shared byte budget across head files, project metadata, and base files", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "consistency-budget-"));
    directories.push(workspaceRoot);

    const cloneWorkspace = vi.fn(async () => {
      // 5 bytes each
      writeFileSync(join(workspaceRoot, "head1.ts"), "12345");
      writeFileSync(join(workspaceRoot, "package.json"), "12345");
      return workspaceRoot;
    });

    const runGitFile = vi.fn(async () => {
      // 5 bytes each
      return { stdout: Buffer.from("12345") };
    });

    const client: PullRequestClient = {
      getPullRequest: async () => ({ baseSha: "base", headSha: "head" }),
      listChangedFiles: async () => [
        { path: "head1.ts", status: "added", additions: 1, deletions: 0, changes: 1 },
        { path: "base1.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
        { path: "base2.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }
      ],
      getDiff: async () => ""
    };

    const context = await buildPRContext({
      jobId: "job_1",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 1,
      installationId: 1,
      baseSha: "base",
      headSha: "head"
    }, {
      authenticator: { getInstallationToken: async () => ({ token: "t", createdAt: "", expiresAt: "" }) },
      clientFactory: () => client,
      cloneWorkspace,
      runGitFile,
      maxTotalBytes: 15 // Only enough for 3 files of 5 bytes each
    });

    // 5 bytes from head1.ts, 5 bytes from package.json, 5 bytes from base1.ts.
    // base2.ts should be skipped because it exceeds the 15-byte limit.

    let totalBytes = 0;
    for (const content of Object.values(context.fileContents)) {
      totalBytes += Buffer.byteLength(content, "utf8");
    }
    for (const content of Object.values(context.projectMetadata)) {
      totalBytes += Buffer.byteLength(content, "utf8");
    }
    for (const content of Object.values(context.baseFileContents)) {
      totalBytes += Buffer.byteLength(content, "utf8");
    }

    expect(totalBytes).toBe(15);
    expect(context.fileContents["head1.ts"]).toBe("12345");
    expect(context.projectMetadata["package.json"]).toBe("12345");
    expect(context.baseFileContents["base1.ts"]).toBe("12345");
    expect(context.baseFileContents["base2.ts"]).toBeUndefined();
  });

  it("filters out secret files and binary buffers from base files", async () => {
    const runGitFile = vi.fn(async (executable, args: string[]) => {
      if (args[1]?.includes("binary.ts")) return { stdout: Buffer.from([0x00, 0x01, 0x02]) };
      return { stdout: Buffer.from("normal content") };
    });

    const client: PullRequestClient = {
      getPullRequest: async () => ({ baseSha: "base", headSha: "head" }),
      listChangedFiles: async () => [
        { path: ".env", status: "modified", additions: 1, deletions: 0, changes: 1 },
        { path: "binary.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
        { path: "normal.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }
      ],
      getDiff: async () => ""
    };

    const context = await buildPRContext({
      jobId: "job",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 1,
      installationId: 1,
      baseSha: "base",
      headSha: "head"
    }, {
      authenticator: { getInstallationToken: async () => ({ token: "t", createdAt: "", expiresAt: "" }) },
      clientFactory: () => client,
      cloneWorkspace: async () => tmpdir(),
      runGitFile
    });

    expect(context.baseFileContents[".env"]).toBeUndefined();
    expect(context.baseFileContents["binary.ts"]).toBeUndefined();
    expect(context.baseFileContents["normal.ts"]).toBe("normal content");
  });

  it("calculates budget based on redacted utf8 output rather than raw buffer size", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "consistency-redact-"));
    directories.push(workspaceRoot);

    const cloneWorkspace = vi.fn(async () => {
      writeFileSync(join(workspaceRoot, "head.ts"), "Bearer a");
      return workspaceRoot;
    });

    // We give a budget of exactly 8 bytes.
    // "Bearer a" is 8 bytes.
    // But it gets redacted to "[REDACTED]" which is 10 bytes!
    // So if the budget uses the final output size, it will be skipped.
    const client: PullRequestClient = {
      getPullRequest: async () => ({ baseSha: "base", headSha: "head" }),
      listChangedFiles: async () => [
        { path: "head.ts", status: "added", additions: 1, deletions: 0, changes: 1 }
      ],
      getDiff: async () => ""
    };

    const context = await buildPRContext({
      jobId: "job_redact",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 1,
      installationId: 1,
      baseSha: "base",
      headSha: "head"
    }, {
      authenticator: { getInstallationToken: async () => ({ token: "t", createdAt: "", expiresAt: "" }) },
      clientFactory: () => client,
      cloneWorkspace,
      maxTotalBytes: 8
    });

    expect(context.fileContents["head.ts"]).toBeUndefined();
  });

  it("calculates budget based on decoded string size, catching expansion on base files", async () => {
    // A single 0xff byte might decode into the replacement character U+FFFD,
    // which in UTF-8 takes 3 bytes. We simulate a scenario where the raw buffer fits
    // the budget, but the decoded string exceeds the budget.
    const runGitFile = vi.fn(async () => {
      return { stdout: Buffer.from([0xff]) }; // 1 byte raw
    });

    const client: PullRequestClient = {
      getPullRequest: async () => ({ baseSha: "base", headSha: "head" }),
      listChangedFiles: async () => [
        { path: "base.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }
      ],
      getDiff: async () => ""
    };

    const context = await buildPRContext({
      jobId: "job_utf8",
      repositoryFullName: "sk1ua/ConsistenCy",
      pullRequestNumber: 1,
      installationId: 1,
      baseSha: "base",
      headSha: "head"
    }, {
      authenticator: { getInstallationToken: async () => ({ token: "t", createdAt: "", expiresAt: "" }) },
      clientFactory: () => client,
      cloneWorkspace: async () => tmpdir(),
      runGitFile,
      maxTotalBytes: 2 // We give it a 2-byte budget. 1 byte raw fits, 3 byte string fails.
    });

    expect(context.baseFileContents["base.ts"]).toBeUndefined();
  });
});
