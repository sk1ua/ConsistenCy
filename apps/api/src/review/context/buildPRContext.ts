import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prReviewContextSchema, type PRReviewContext, type ReviewAccessMode } from "@consistency/schema";

const execFileAsync = promisify(execFile);
import type { GitHubAppAuthenticator } from "../../github/auth";
import {
  OctokitPullRequestClient,
  GitHubApiError,
  splitRepositoryFullName,
  type PullRequestClient
} from "../../github/client";
import { clonePullRequestWorkspace } from "../../github/clone";
import { mapGitHubError } from "../publicPr";
import { loadWorkspaceFiles, isSecretPath } from "./fileLoader";

const PROJECT_METADATA_FILES = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "README.md",
  "README.rst",
  "pytest.ini",
  "tox.ini",
  "vitest.config.ts",
  "vite.config.ts",
  "jest.config.js",
  "jest.config.ts"
];
const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;
const DEFAULT_MAX_PATCH_BYTES = 64 * 1024;

export class PublicPrSnapshotChangedError extends Error {
  readonly code = "PUBLIC_GITHUB_SNAPSHOT_CHANGED" as const;

  constructor() {
    super("The public pull request changed while analysis was starting");
    this.name = "PublicPrSnapshotChangedError";
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated by ConsistenCy]`;
}

export type BuildPRContextInput = {
  jobId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  installationId?: number;
  accessMode?: ReviewAccessMode;
  baseSha: string;
  headSha: string;
};

export async function buildPRContext(
  input: BuildPRContextInput,
  dependencies: {
    authenticator?: Pick<GitHubAppAuthenticator, "getInstallationToken">;
    publicReadToken?: string;
    clientFactory?: (token?: string) => PullRequestClient;
    cloneWorkspace?: typeof clonePullRequestWorkspace;
    runGitFile?: (executable: string, args: string[], options: { cwd: string; maxBuffer: number; encoding: "buffer"; windowsHide: boolean }) => Promise<{ stdout: Buffer }>;
    workspaceRoot?: string;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxDiffBytes?: number;
    maxPatchBytes?: number;
  }
): Promise<PRReviewContext> {
  const { owner, repo } = splitRepositoryFullName(input.repositoryFullName);
  const accessMode = input.accessMode ?? "github_app";
  let token: string | undefined;
  if (accessMode === "github_app") {
    if (!dependencies.authenticator || !input.installationId) {
      throw new Error("GitHub App credentials or installation ID are required for this review");
    }
    token = (await dependencies.authenticator.getInstallationToken(input.installationId)).token;
  } else {
    token = dependencies.publicReadToken;
  }
  const client = dependencies.clientFactory?.(token)
    ?? new OctokitPullRequestClient(token);
  const coordinates = { owner, repo, pullRequestNumber: input.pullRequestNumber };
  let pullRequest: Awaited<ReturnType<PullRequestClient["getPullRequest"]>>;
  let rawChangedFiles: Awaited<ReturnType<PullRequestClient["listChangedFiles"]>>;
  let rawDiff: string;
  try {
    [pullRequest, rawChangedFiles, rawDiff] = await Promise.all([
      client.getPullRequest(coordinates),
      client.listChangedFiles(coordinates),
      client.getDiff(coordinates)
    ]);
  } catch (error) {
    if (accessMode === "public_read" && error instanceof GitHubApiError) throw mapGitHubError(error);
    throw error;
  }
  if (pullRequest.baseSha !== input.baseSha || pullRequest.headSha !== input.headSha) {
    if (accessMode === "public_read") throw new PublicPrSnapshotChangedError();
    throw new Error("Pull request SHAs changed before context construction completed");
  }
  const changedFiles = rawChangedFiles.map(file => {
    if (file.path.includes("\0")) {
      throw new Error("File path contains NUL character");
    }
    return {
      ...file,
      patch: file.patch === undefined
        ? undefined
        : truncateUtf8(file.patch, dependencies.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES)
    };
  });
  const diff = truncateUtf8(rawDiff, dependencies.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES);

  const workspaceRoot = resolve(dependencies.workspaceRoot ?? ".consistency/workspaces");
  let workspacePath: string;
  try {
    workspacePath = await (dependencies.cloneWorkspace ?? clonePullRequestWorkspace)({
    repositoryFullName: input.repositoryFullName,
    headSha: input.headSha,
    baseSha: input.baseSha,
    jobId: input.jobId,
    token,
    workspaceRoot
    });
  } catch (error) {
    if (accessMode === "public_read") throw mapGitHubError(error);
    throw error;
  }
  const budget = {
    limit: dependencies.maxTotalBytes ?? 2 * 1024 * 1024,
    used: 0
  };

  const loaderOptions = {
    workspacePath,
    maxFileBytes: dependencies.maxFileBytes,
    budget
  };
  const fileContents = loadWorkspaceFiles({
    ...loaderOptions,
    paths: changedFiles.filter(file => file.status !== "removed").map(file => file.path)
  });
  const projectMetadata = loadWorkspaceFiles({
    ...loaderOptions,
    paths: PROJECT_METADATA_FILES
  });

  const baseFileContents: Record<string, string> = {};
  for (const file of changedFiles) {
    if (file.status === "added") continue;
    if (isSecretPath(file.path)) continue;

    try {
      let stdout: Buffer;
      const maxBuffer = dependencies.maxFileBytes ?? 256 * 1024;
      const args = ["show", `${input.baseSha}:${file.path}`];
      const execOptions = { cwd: workspacePath, maxBuffer, encoding: "buffer" as const, windowsHide: true };

      if (dependencies.runGitFile) {
        const result = await dependencies.runGitFile("git", args, execOptions);
        stdout = result.stdout;
      } else {
        const result = await execFileAsync("git", args, execOptions);
        stdout = result.stdout;
      }

      const rawSize = stdout.length;
      if (rawSize > maxBuffer) continue;
      if (stdout.includes(0)) continue;

      const content = stdout.toString("utf8");
      const outputSize = Buffer.byteLength(content, "utf8");

      if (budget.used + outputSize > budget.limit) continue;

      baseFileContents[file.path] = content;
      budget.used += outputSize;
    } catch {
      // Ignore errors if git show fails
    }
  }

  return prReviewContextSchema.parse({
    jobId: input.jobId,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedFiles,
    diff,
    fileContents,
    baseFileContents,
    projectMetadata,
    workspacePath
  });
}
