import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prReviewContextSchema } from "@consistency/schema";
import type { PullRequestClient } from "../../github/client";
import { buildPRContext } from "./buildPRContext";

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
});
