import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { splitRepositoryFullName } from "./client";

export type RunGit = (
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv }
) => Promise<void>;

const defaultRunGit: RunGit = (args, options) => new Promise((resolvePromise, reject) => {
  const child = spawn("git", args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => {
    if (stderr.length < 4_096) stderr += chunk.toString();
  });
  child.on("error", reject);
  child.on("close", code => {
    if (code === 0) resolvePromise();
    else reject(new Error(`git command failed with exit code ${code}: ${stderr.trim().slice(0, 500)}`));
  });
});

export function workspacePathForJob(workspaceRoot: string, jobId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error("jobId contains unsafe path characters");
  }
  const root = resolve(workspaceRoot);
  const workspace = resolve(root, jobId);
  if (!workspace.startsWith(`${root}${sep}`)) {
    throw new Error("Workspace must be inside the configured workspace root");
  }
  return workspace;
}

export async function clonePullRequestWorkspace(options: {
  repositoryFullName: string;
  headSha: string;
  baseSha?: string;
  jobId: string;
  token?: string;
  workspaceRoot?: string;
  runGit?: RunGit;
}): Promise<string> {
  const { owner, repo } = splitRepositoryFullName(options.repositoryFullName);
  if (!/^[0-9a-f]{7,64}$/i.test(options.headSha)) {
    throw new Error("headSha must be a hexadecimal Git object id");
  }
  if (options.baseSha && !/^[0-9a-f]{7,64}$/i.test(options.baseSha)) {
    throw new Error("baseSha must be a hexadecimal Git object id");
  }
  const workspaceRoot = resolve(options.workspaceRoot ?? ".consistency/workspaces");
  const workspacePath = workspacePathForJob(workspaceRoot, options.jobId);
  mkdirSync(workspaceRoot, { recursive: true });
  if (existsSync(workspacePath)) rmSync(workspacePath, { recursive: true, force: true });

  const runGit = options.runGit ?? defaultRunGit;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_PUBLIC_READ_TOKEN;
  env.GIT_TERMINAL_PROMPT = "0";
  if (options.token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`;
  }
  const url = `https://github.com/${owner}/${repo}.git`;
  try {
    await runGit(["clone", "--no-checkout", "--filter=blob:none", url, workspacePath], { env });
    if (options.baseSha) {
      await runGit(["fetch", "origin", options.headSha, options.baseSha, "--depth=1"], { cwd: workspacePath, env });
    } else {
      await runGit(["fetch", "origin", options.headSha, "--depth=1"], { cwd: workspacePath, env });
    }
    await runGit(["checkout", "--detach", options.headSha], { cwd: workspacePath, env });
    return workspacePath;
  } catch (error) {
    if (existsSync(workspacePath) && workspacePath.startsWith(`${workspaceRoot}${sep}`)) {
      rmSync(workspacePath, { recursive: true, force: true });
    }
    throw error;
  }
}
