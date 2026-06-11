import { resolve } from "node:path";
import { prReviewContextSchema, type PRReviewContext } from "@consistency/schema";
import type { GitHubAppAuthenticator } from "../../github/auth";
import {
  OctokitPullRequestClient,
  splitRepositoryFullName,
  type PullRequestClient
} from "../../github/client";
import { clonePullRequestWorkspace } from "../../github/clone";
import { loadWorkspaceFiles } from "./fileLoader";

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

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated by ConsistenCy]`;
}

export type BuildPRContextInput = {
  jobId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  installationId: number;
  baseSha: string;
  headSha: string;
};

export async function buildPRContext(
  input: BuildPRContextInput,
  dependencies: {
    authenticator: Pick<GitHubAppAuthenticator, "getInstallationToken">;
    clientFactory?: (token: string) => PullRequestClient;
    cloneWorkspace?: typeof clonePullRequestWorkspace;
    workspaceRoot?: string;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxDiffBytes?: number;
    maxPatchBytes?: number;
  }
): Promise<PRReviewContext> {
  const { owner, repo } = splitRepositoryFullName(input.repositoryFullName);
  const authentication = await dependencies.authenticator.getInstallationToken(input.installationId);
  const client = dependencies.clientFactory?.(authentication.token)
    ?? new OctokitPullRequestClient(authentication.token);
  const coordinates = { owner, repo, pullRequestNumber: input.pullRequestNumber };
  const [pullRequest, rawChangedFiles, rawDiff] = await Promise.all([
    client.getPullRequest(coordinates),
    client.listChangedFiles(coordinates),
    client.getDiff(coordinates)
  ]);
  if (pullRequest.baseSha !== input.baseSha || pullRequest.headSha !== input.headSha) {
    throw new Error("Pull request SHAs changed before context construction completed");
  }
  const changedFiles = rawChangedFiles.map(file => ({
    ...file,
    patch: file.patch === undefined
      ? undefined
      : truncateUtf8(file.patch, dependencies.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES)
  }));
  const diff = truncateUtf8(rawDiff, dependencies.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES);

  const workspaceRoot = resolve(dependencies.workspaceRoot ?? ".consistency/workspaces");
  const workspacePath = await (dependencies.cloneWorkspace ?? clonePullRequestWorkspace)({
    repositoryFullName: input.repositoryFullName,
    headSha: input.headSha,
    jobId: input.jobId,
    token: authentication.token,
    workspaceRoot
  });
  const loaderOptions = {
    workspacePath,
    maxFileBytes: dependencies.maxFileBytes,
    maxTotalBytes: dependencies.maxTotalBytes
  };
  const fileContents = loadWorkspaceFiles({
    ...loaderOptions,
    paths: changedFiles.filter(file => file.status !== "removed").map(file => file.path)
  });
  const projectMetadata = loadWorkspaceFiles({
    ...loaderOptions,
    paths: PROJECT_METADATA_FILES
  });

  return prReviewContextSchema.parse({
    jobId: input.jobId,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    changedFiles,
    diff,
    fileContents,
    projectMetadata,
    workspacePath
  });
}
