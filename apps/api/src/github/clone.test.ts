import { mkdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clonePullRequestWorkspace, workspacePathForJob, type RunGit } from "./clone";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("clonePullRequestWorkspace", () => {
  it("keeps credentials out of git arguments and checks out the requested SHA", async () => {
    const root = mkdtempSync(join(tmpdir(), "consistency-workspaces-"));
    directories.push(root);
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd?: string }> = [];
    const runGit: RunGit = async (args, options) => {
      calls.push({ args, ...options });
      if (args[0] === "clone") mkdirSync(args.at(-1)!);
    };

    const workspace = await clonePullRequestWorkspace({
      repositoryFullName: "sk1ua/ConsistenCy",
      headSha: "abcdef1234567",
      jobId: "job_123",
      token: "secret-installation-token",
      workspaceRoot: root,
      runGit
    });

    expect(workspace).toBe(join(root, "job_123"));
    expect(calls.map(call => call.args[0])).toEqual(["clone", "fetch", "checkout"]);
    expect(JSON.stringify(calls.map(call => call.args))).not.toContain("secret-installation-token");
    const header = calls[0]?.env.GIT_CONFIG_VALUE_0 ?? "";
    expect(header).toMatch(/^Authorization: Basic /);
    expect(Buffer.from(header.replace("Authorization: Basic ", ""), "base64").toString("utf8"))
      .toBe("x-access-token:secret-installation-token");
  });

  it("rejects unsafe job and repository identifiers", async () => {
    expect(() => workspacePathForJob("C:/workspaces", "../escape")).toThrow(/unsafe/);
    await expect(clonePullRequestWorkspace({
      repositoryFullName: "owner/repo/extra",
      headSha: "abcdef1234567",
      jobId: "job-1",
      token: "token"
    })).rejects.toThrow(/owner\/repository/);
  });

  it("does not add an Authorization header for anonymous public clones", async () => {
    const root = mkdtempSync(join(tmpdir(), "consistency-public-workspaces-"));
    directories.push(root);
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd?: string }> = [];
    const runGit: RunGit = async (args, options) => {
      calls.push({ args, ...options });
      if (args[0] === "clone") mkdirSync(args.at(-1)!);
    };

    await clonePullRequestWorkspace({
      repositoryFullName: "espnet/espnet",
      headSha: "abcdef1234567",
      jobId: "public_job",
      workspaceRoot: root,
      runGit
    });

    expect(calls[0]?.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(calls[0]?.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(calls[0]?.env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });
});
